# Marginalia Databricks services diagram

Editable tldraw SDK canvas explaining the Databricks architecture in PR #39,
the purpose of each platform service, alternatives by layer, and current review
findings.

```sh
npm install
npm run dev
```

The development server listens on `127.0.0.1:4174`. From another machine, use
an SSH tunnel and open `http://localhost:4174`:

```sh
ssh -L 4174:127.0.0.1:4174 <user>@<remote-host>
```

Canvas changes persist in that browser under the tldraw persistence key
`marginalia-databricks-services-v1`.
