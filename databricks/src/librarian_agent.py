"""
The served Librarian: retrieval, one model call, and a refusal to show an answer
it cannot stand behind.

This is the module that is logged to MLflow and loaded by the serving endpoint.
It holds the wiring and none of the rules; the rules are in librarian.py, which
has no network and is tested against fixed responses.

Tracing is the point of doing it this way. Each request produces one trace with
a retrieval span and a generation span, so what the model was shown is
recoverable afterwards without logging the passages themselves anywhere else.

Two things this deliberately does not do:

- accept a reader id from anywhere but the request field. A question is text,
  and text that could select a reader would be a question that could name
  somebody else.
- return an answer that failed validation. A rejected answer becomes an error
  with its reasons, because showing a claim with a fabricated citation is worse
  than showing nothing, and the reader has no way to tell them apart.

What it cannot do is decide whether the caller was entitled to name that
reader. `user_id` arrives in the request, so anyone who can query this endpoint
can ask about anyone, and the second filter proves only that the rows match the
id that was asked for rather than the identity that asked. The boundary is
therefore the endpoint's own permissions, exactly as the serving App's boundary
is `MARGINALIA_TRUSTED_CALLER`: only a server-side identity that already knows
which reader it is acting for may query it, and no reader-facing route may pass
a browser-supplied id through. Said here rather than implied, because the two
filters look like the whole of the protection and are not.
"""

import json
import os

import mlflow
import pandas as pd

from librarian import (
    DEFAULT_K,
    answer_question,
    build_messages,
    own_passages_within,
    reply_text,
    retrieval_filters,
)

# Set when the model is logged, read when it is served.
INDEX_NAME = os.environ.get("MARGINALIA_LIBRARIAN_INDEX", "")
CHAT_ENDPOINT = os.environ.get("MARGINALIA_LIBRARIAN_ENDPOINT", "databricks-gpt-oss-120b")

# Columns the index returns alongside the match. `content` is last because the
# service returns them in this order and the score is appended after them.
RETURN_COLUMNS = [
    "passage_id",
    "user_id",
    "book_id",
    "chapter",
    "progress",
    "source_type",
    "source_id",
    "content",
]


class Librarian(mlflow.pyfunc.PythonModel):
    def load_context(self, context):  # noqa: ARG002 - the signature is MLflow's
        from databricks.sdk import WorkspaceClient

        self._client = WorkspaceClient()
        self._index = os.environ.get("MARGINALIA_LIBRARIAN_INDEX", INDEX_NAME)
        self._chat = os.environ.get("MARGINALIA_LIBRARIAN_ENDPOINT", CHAT_ENDPOINT)

    @mlflow.trace(span_type="RETRIEVER")
    def retrieve(self, question: str, user_id: str, book_id: str | None, spoiler_progress, k: int):
        """
        The reader's own passages, up to their position, nearest to the question.

        The filter is applied twice on purpose. Once as a request to the index,
        and once to what it returned: a filter that silently stopped being
        applied would be invisible in an answer that reads correctly.
        """
        filters = retrieval_filters(user_id, book_id, spoiler_progress)
        response = self._client.vector_search_indexes.query_index(
            index_name=self._index,
            columns=RETURN_COLUMNS,
            query_text=question,
            filters_json=_filters_json(filters),
            num_results=k,
        )
        rows = (getattr(response, "result", None) and response.result.data_array) or []
        retrieved = [dict(zip(RETURN_COLUMNS, row)) for row in rows]

        # The service was asked for one reader, up to one position. Anything
        # else in the answer is dropped rather than trusted, because a
        # retriever that ignored a filter is exactly the failure that would
        # never show up in the text of a reply.
        #
        # The dropping is in librarian.py rather than here, so the code that
        # runs in production is the code the contract tests exercise.
        within = own_passages_within(retrieved, user_id, spoiler_progress)

        # What the second filter removed, kept as ids so the evaluation can
        # measure the index rather than the filter in front of it. Without this
        # a leak the filter caught scores as zero cross-reader evidence, which
        # reads as an index that honoured its filters and is the opposite of
        # what happened. Ids only: the text is dropped with the row.
        kept = {passage["passage_id"] for passage in within}
        dropped = [passage["passage_id"] for passage in retrieved if passage["passage_id"] not in kept]
        mlflow.update_current_trace(
            tags={"retrieved": str(len(retrieved)), "dropped_by_the_second_filter": str(len(dropped))}
        )
        # Returned rather than stashed on the instance. One served model
        # answers concurrent requests, and instance state between retrieval and
        # the reply is one request reading another's.
        return within, dropped

    @mlflow.trace(span_type="LLM")
    def generate(self, question: str, passages: list[dict]) -> tuple[str, dict | None]:
        from databricks.sdk.service.serving import ChatMessage, ChatMessageRole

        messages = build_messages(question, passages)
        roles = {"system": ChatMessageRole.SYSTEM, "user": ChatMessageRole.USER}
        response = self._client.serving_endpoints.query(
            name=self._chat,
            messages=[ChatMessage(role=roles[m["role"]], content=m["content"]) for m in messages],
            temperature=0.0,
            max_tokens=800,
        )
        counted = _usage(getattr(response, "usage", None))
        if counted:
            # On the trace as well as in the reply, so a question that was asked
            # and never answered still shows what it cost.
            mlflow.update_current_trace(tags={key: str(value) for key, value in counted.items()})

        # Not `.content` directly: a reasoning model returns a list of parts
        # rather than a string, and reading it as one gets an empty answer and
        # a withheld reply blaming the model for returning nothing.
        return reply_text(response.choices[0].message.content), counted

    @mlflow.trace(span_type="AGENT")
    def answer(self, request: dict) -> dict:
        """
        The exchange itself lives in librarian.answer_question, which takes
        retrieval and generation as arguments. This supplies the traced ones;
        the contract tests supply fixed ones. Nothing about which answers are
        withheld is decided here.
        """
        user_id = (request.get("user_id") or "").strip()
        if user_id:
            # The one reader identifier on the trace, and the only thing that
            # makes a trace findable when that reader asks to be deleted. A
            # trace holds the passages the model was shown, so an untagged one
            # would be reader text in a store the deletion job cannot reach.
            mlflow.update_current_trace(tags={"marginalia.user_id": user_id})

        result = answer_question(request, self.retrieve, self.generate)
        result.setdefault("model", self._chat)
        return result

    def predict(self, context, model_input, params=None):  # noqa: ARG002
        """
        One JSON string per request.

        A reply has two shapes: an answer with its evidence, or a withheld one
        with the reasons it was withheld. A model signature has to name one
        output schema, and naming either would be wrong about the other, so the
        column is a string and the shape is inside it. Unity Catalog requires a
        signature, which is what settled this.
        """
        if isinstance(model_input, pd.DataFrame):
            requests = model_input.to_dict("records")
        elif isinstance(model_input, dict):
            requests = [model_input]
        else:
            requests = list(model_input)
        return [json.dumps(self.answer(request)) for request in requests]


def _usage(usage) -> dict | None:
    """
    Token counts, from an object or a mapping.

    The SDK returns a typed object for some endpoints and leaves the raw
    mapping for others, and reading only the attributes gets None from a dict
    without failing, which reads as a model that reported no usage.
    """
    if usage is None:
        return None
    fields = ("prompt_tokens", "completion_tokens", "total_tokens")
    if isinstance(usage, dict):
        counted = {field: usage.get(field) for field in fields}
    else:
        counted = {field: getattr(usage, field, None) for field in fields}
    return counted if any(value is not None for value in counted.values()) else None


def _filters_json(filters: dict) -> str:
    """Vector Search takes its filters as a JSON string rather than a mapping."""
    return json.dumps(filters)


# Models from code: MLflow logs this file rather than a pickle, and this is the
# line that tells it which object in the file is the model. Without it the log
# succeeds and the endpoint has nothing to serve.
mlflow.models.set_model(Librarian())
