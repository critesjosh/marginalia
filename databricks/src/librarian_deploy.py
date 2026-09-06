"""
Log the Librarian, register it, and put it behind a serving endpoint.

A job task rather than something run from a laptop. The model has to be logged
somewhere that can reach the workspace's MLflow and Unity Catalog, and a deploy
that depends on whose machine it ran from is a deploy nobody can repeat.

The endpoint is given the index and the chat endpoint as declared resources.
That is what makes automatic authentication work at serving time: the endpoint's
identity is granted exactly those two things, rather than the model carrying a
token of its own. A token in a logged model would be a credential in an artifact
store, which is the thing this whole system has avoided everywhere else.

Nothing here decides anything about answers. It moves librarian.py and
librarian_agent.py into a place that can serve them.
"""

import pathlib
import sys

import mlflow
from mlflow.models import ModelSignature
from mlflow.models.resources import DatabricksServingEndpoint, DatabricksVectorSearchIndex
from mlflow.types import ColSpec, DataType, Schema

import librarian


def _argument(name: str, fallback: str | None = None) -> str:
    prefix = f"--{name}="
    for argument in sys.argv[1:]:
        if argument.startswith(prefix):
            return argument[len(prefix) :]
    if fallback is None:
        raise SystemExit(f"missing required job parameter --{name}")
    return fallback


CATALOG = _argument("catalog")
GOLD = _argument("gold_schema")
INDEX = _argument("index_name")
CHAT_ENDPOINT = _argument("chat_endpoint")
ENDPOINT = _argument("serving_endpoint")
EXPERIMENT = _argument("experiment")

MODEL = f"{CATALOG}.{GOLD}.librarian"

# Absolute, and taken from the imported module rather than from `__file__`.
#
# A serverless Python task compiles and executes the script without setting
# `__file__`, so reading it raises NameError before anything else runs. An
# imported module has one, and `librarian` is imported here anyway. The task
# runner puts the script's own directory on the path, which is why a bare
# import of a sibling works at all.
HERE = pathlib.Path(librarian.__file__).resolve().parent
AGENT = str(HERE / "librarian_agent.py")
RULES = str(HERE / "librarian.py")

# Written out rather than inferred from an example.
#
# Inferring calls predict, and predict here queries a live index and a live
# model, so logging would depend on retrieval working and would send a request
# under a made-up reader id to find out. Unity Catalog requires a signature, so
# omitting one is not an option either: registration refuses a model without
# both halves.
#
# The output is one string holding JSON, because a reply has two shapes: an
# answer with evidence, or a withheld one with its reasons. A schema naming
# either would be wrong about the other.
SIGNATURE = ModelSignature(
    inputs=Schema(
        [
            ColSpec(DataType.string, "question"),
            # The reader, from the caller. Never parsed out of the question.
            ColSpec(DataType.string, "user_id"),
            ColSpec(DataType.string, "book_id", required=False),
            # The spoiler position, and required. An absent one used to mean no
            # bound, so a request that simply omitted the field saw the whole
            # book; asking for all of it is still possible and now has to be
            # said, as 1.0.
            ColSpec(DataType.double, "spoiler_progress"),
            ColSpec(DataType.long, "k", required=False),
            # Returns the model's own prose from a reply that declined. Off
            # unless asked for: that field is the one place a reply need not
            # cite anything, so a route displaying it would display an uncited
            # claim. The evaluation asks; a reader-facing route must not.
            ColSpec(DataType.boolean, "include_model_note", required=False),
        ]
    ),
    outputs=Schema([ColSpec(DataType.string)]),
)


def log_and_register() -> str:
    mlflow.set_registry_uri("databricks-uc")
    mlflow.set_experiment(EXPERIMENT)

    with mlflow.start_run(run_name="librarian") as run:
        mlflow.log_params(
            {
                "index": INDEX,
                "chat_endpoint": CHAT_ENDPOINT,
                # The prompt version is a parameter rather than a tag because a
                # change to it is a different model, and comparing two runs
                # that differ in the prompt is the point of recording it.
                "prompt_version": _prompt_version(),
            }
        )
        info = mlflow.pyfunc.log_model(
            name="librarian",
            python_model=AGENT,
            code_paths=[RULES],
            signature=SIGNATURE,
            metadata={"prompt_version": _prompt_version()},
            registered_model_name=MODEL,
            resources=[
                DatabricksVectorSearchIndex(index_name=INDEX),
                DatabricksServingEndpoint(endpoint_name=CHAT_ENDPOINT),
            ],
            pip_requirements=["mlflow", "databricks-sdk", "pandas"],
        )
        print(f"logged {info.model_uri} in run {run.info.run_id}")

    from mlflow.tracking import MlflowClient

    versions = MlflowClient().search_model_versions(f"name='{MODEL}'")
    latest = max(versions, key=lambda version: int(version.version))
    print(f"registered {MODEL} version {latest.version}")
    return latest.version


def _prompt_version() -> str:
    return librarian.PROMPT_VERSION


def _experiment_id() -> str:
    """The experiment the endpoint should write its traces to."""
    from mlflow.tracking import MlflowClient

    experiment = MlflowClient().get_experiment_by_name(EXPERIMENT)
    if experiment is None:
        raise SystemExit(f"{EXPERIMENT} does not exist, so the endpoint would trace to nowhere")
    return experiment.experiment_id


def serve(version: str) -> None:
    from databricks.sdk import WorkspaceClient
    from databricks.sdk.service.serving import (
        EndpointCoreConfigInput,
        ServedEntityInput,
    )

    client = WorkspaceClient()
    entity = ServedEntityInput(
        name="librarian",
        entity_name=MODEL,
        entity_version=version,
        workload_size="Small",
        # A reader asks a question every so often, not continuously. Paying for
        # a warm endpoint between questions would cost more than the questions.
        # The accepted price is a cold start on the first one after a quiet
        # spell, which is why the latency threshold is measured warm and said
        # so rather than quoted as though it were every request.
        scale_to_zero_enabled=True,
        environment_vars={
            "MARGINALIA_LIBRARIAN_INDEX": INDEX,
            "MARGINALIA_LIBRARIAN_ENDPOINT": CHAT_ENDPOINT,
            # Without these two the @mlflow.trace decorators run and their
            # traces go nowhere. The endpoint served questions for a day and
            # the experiment held nothing, which made every claim about what a
            # trace records, and about deleting one, true of an empty set.
            "ENABLE_MLFLOW_TRACING": "true",
            "MLFLOW_EXPERIMENT_ID": _experiment_id(),
        },
    )

    existing = None
    try:
        existing = client.serving_endpoints.get(ENDPOINT)
    except Exception:  # noqa: BLE001 - the first deploy has nothing to get
        existing = None

    if existing is None:
        client.serving_endpoints.create_and_wait(
            name=ENDPOINT,
            # The endpoint name again, inside the config. The SDK requires it
            # there as well as beside it, and omitting it raises a TypeError
            # rather than being defaulted from the argument next to it.
            config=EndpointCoreConfigInput(name=ENDPOINT, served_entities=[entity]),
        )
        print(f"created serving endpoint {ENDPOINT} on version {version}")
    else:
        client.serving_endpoints.update_config_and_wait(name=ENDPOINT, served_entities=[entity])
        print(f"updated serving endpoint {ENDPOINT} to version {version}")


def main() -> None:
    version = log_and_register()
    serve(version)


if __name__ == "__main__":
    main()
