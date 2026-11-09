# wavebird API

Integrate Banner, Native and Clip ads into your AI app. wavebird handles ad delivery and consent. Your app keeps its existing login, model and result display.

[API docs](https://wavebird.ai/api/quickstart) | [Dashboard](https://dashboard.wavebird.ai/wavebird) | [Troubleshooting](https://wavebird.ai/api/troubleshooting)

## Choose your language

| Language | Package and guide |
| --- | --- |
| JavaScript | `@wavebirdai/api`, follow the steps below |
| TypeScript | `@wavebirdai/api`, with included types and TypeScript examples |
| Python | `wavebird-publisher-server`, follow the [Python guide](python/README.md) |

Native iOS and Android packages are not currently available. See [integration paths](https://wavebird.ai/api/integration-paths) for supported environments.

## Set up JavaScript or TypeScript

Use Node.js 20 or later on your server.

1. **Open your project in Dashboard.** Choose your language and package version. In App settings, verify the domain using a DNS TXT record or HTTPS file, then save your HTTPS app URL and approved origins. `www.example.com` and `example.com` are separate hosts.
2. **Install the package.** Run this in your app's terminal, in the folder containing `package.json`:

   ```sh
   npm install @wavebirdai/api@0.1.0-beta.15
   ```

3. **Save the Server ENV from Overview, Integration step 2.** The key-only download is not the full configuration. Keep `WAVEBIRD_SECRET_KEY` and the stable, project-specific `WAVEBIRD_PREFERENCE_SECRET` out of browser code and Git. Include the saved `WAVEBIRD_PUBLIC_ORIGINS`.
4. **Connect the backend and frontend code.** Follow Dashboard's generated files to connect your app session, durable turn storage, model stream and ad slot. Keep the saved formats, sizes and timing.
5. **Run your first Test ad.** Confirm that the ad appears and the request is recorded in Test Logs. Check that generation still works with declined consent, no available ad and Stop.

Test ads are nonpayable. Complete the [Live prerequisites](https://wavebird.ai/api/guides/going-live) before requesting Live activation.

For Next.js, you can use the [generator](docs/web/nextjs.md) instead of copying Dashboard's route files.

## Connect your model output

Use `@wavebirdai/api/server` on the server and `@wavebirdai/api/browser` for the ad slot. Your response consumer must display the model output and finish only after the result is visible.

[JavaScript and TypeScript examples](docs/web/generation.md) | [Server and browser reference](docs/web/reference.md)

## Update an existing integration

Keep your installed version until you choose to upgrade. Follow the [migration guide](https://wavebird.ai/api/reference/versioning) and check the affected integration before deployment. The older `wavebird` npm package uses a different integration path.

[Configuration](https://wavebird.ai/api/configuration) | [REST reference](https://wavebird.ai/api/reference/endpoints) | [Report an issue](https://github.com/wavebird-ai/api/issues)
