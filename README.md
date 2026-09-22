# brickskate

Wakes a stopped [Databricks App](https://docs.databricks.com/aws/en/dev-tools/databricks-apps/) when someone shows up, and can put it back to sleep on a timer. One Lambda, one CloudFront distribution, no servers and nothing to keep running.

## Why

A stopped Databricks App serves `503` at its own URL and cannot wake itself. On Free Edition the platform stops apps after a period of inactivity, so the next person who opens your link gets an error page rather than your app. On other workspaces the app keeps running until something stops it.

brickskate fixes both ends. Point people at brickskate instead of the app. It checks the app, starts it if needed, holds the visitor on a waiting page, and drops them into the app the moment it is genuinely serving. Optionally it also stops the app on a schedule.

## How it works

1. A request hits CloudFront, which forwards it to an API Gateway HTTP API and on to the wake Lambda.
2. The Lambda authenticates to the control plane as a service principal using OAuth machine-to-machine, reading the client secret from SSM Parameter Store. Free Edition has no personal access tokens, so this is the only option there and works everywhere else too.
3. It reads `GET /api/2.0/apps/{name}`. The app counts as serving only when the compute state is `ACTIVE` **and** the app state is `RUNNING`, and only when a `redirect: "manual"` probe of the app URL comes back as something other than `503`. The control plane reports `RUNNING` a little before ingress actually serves, and the probe is what stops you redirecting someone onto the error page.
4. If the app is stopped, it calls `POST /api/2.0/apps/{name}/start` and tolerates a non-2xx response, because "already starting" and "deploy pending" both look like errors. Then it serves a small self-contained waiting page.
5. The waiting page polls `/status` every 3 seconds, narrates the stage it is in, gives up after 300 seconds, and calls `location.replace()` into the app as soon as the status says ready.

A typical cold wake takes a minute or two, most of it the app installing its dependencies.

## Deploy it in about five minutes

You need the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html), the [Databricks CLI](https://docs.databricks.com/aws/en/dev-tools/cli/), and an AWS account.

1. **Create a service principal** in your workspace and give it `CAN_MANAGE` on the app. Note its numeric ID and its client ID (a UUID).

2. **Mint its OAuth secret into SSM.** This never prints the secret.

   ```bash
   scripts/mint-secret.sh <service-principal-id>
   ```

   Pass a different parameter name as a second argument if you do not want the default `/brickskate/client-secret`, and set `DATABRICKS_PROFILE` if you use a named CLI profile.

3. **Configure the stack.**

   ```bash
   cp samconfig.toml.example samconfig.toml
   ```

   Fill in `DatabricksHost`, `AppName`, `AppUrl` and `DatabricksClientId`.

4. **Deploy.**

   ```bash
   sam build && sam deploy
   ```

   The `WakeUrl` output is the link to share. With no custom domain configured that is the CloudFront domain, which works fine.

5. **Optional, add a custom domain.** Set `DomainName`, `HostedZoneId` and `CertificateArn`, then deploy again. The stack adds the CloudFront alias and the Route 53 A and AAAA records for you.

## Parameters

| Parameter | Default | What it is |
| --- | --- | --- |
| `DatabricksHost` | required | Workspace URL, no trailing slash |
| `AppName` | required | App name as shown by `databricks apps list` |
| `AppUrl` | required | The app's own URL, the one that serves `503` while stopped |
| `DatabricksClientId` | required | Client ID (UUID) of the service principal |
| `SecretParameterName` | `/brickskate/client-secret` | SSM SecureString holding that principal's OAuth secret |
| `FunctionNamePrefix` | `brickskate` | Prefix for Lambda, log group and rule names, so you can run several |
| `DomainName` | empty | Optional custom domain |
| `HostedZoneId` | empty | Route 53 zone for that domain |
| `CertificateArn` | empty | ACM certificate for that domain, **must be issued in us-east-1** |
| `StopSchedule` | empty | Optional schedule expression that stops the app |

Two things worth knowing before you deploy:

- **CloudFront only accepts certificates from us-east-1**, no matter which region this stack lives in. Request or import the certificate there first, then paste the ARN.
- **CloudFront is in the path even without a custom domain**, because API Gateway custom domains never listen on port 80 and CloudFront is what turns `http://` into a redirect to `https://`. Caching is disabled on the behaviour, so nothing stale is ever served.

## Stopping on a timer

Set `StopSchedule` to an [EventBridge schedule expression](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-rule-schedule.html) and the stack adds a second Lambda, its own log group, and a rule that invokes it:

```
StopSchedule="cron(0 14 * * ? *)"   # 14:00 UTC daily
StopSchedule="rate(12 hours)"
```

The stop Lambda is deliberately blunt. It reads the state and, if the app is not already stopped, calls `POST /api/2.0/apps/{name}/stop`. There is no idle detection, because the Apps API does not expose a last-request timestamp. If you want "stop only when quiet", schedule it for a time of day when quiet is a safe assumption. Waking it again is what the rest of this repository does.

Leave `StopSchedule` empty and none of those resources are created.

## Layout

```
src/common.mjs        OAuth token, app status, start, stop, readiness probe
src/handler.mjs       wake handler: routes / and /status, serves the waiting page
src/stop-handler.mjs  scheduled stop handler
template.yaml         SAM template, everything parameterised
scripts/mint-secret.sh   put a service principal secret into SSM without printing it
```

No npm dependencies. `@aws-sdk/client-ssm` ships with the Lambda Node.js runtime, and everything else is `fetch`.

## Credits

Extracted from a working private project in July 2026, where it has been waking a Free Edition app on demand since. Generalised and released September 2026.

## Licence

MIT. See [LICENSE](LICENSE).
