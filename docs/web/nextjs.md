# Next.js generator

Use this path instead of copying Dashboard's route files. It supports an existing Next.js App Router app with JavaScript or TypeScript. Use the saved Dashboard configuration in either path.

## Generate files

From the folder containing `package.json`:

```sh
npm install @wavebirdai/api@0.1.0-beta.13
./node_modules/.bin/wavebird-next init --lang ts --root . --app-dir src/app
```

For JavaScript, use `--lang js`. For a root-level `app/` directory, use `--app-dir app`. The generator does not overwrite existing files. Read the generated `WAVEBIRD-SETUP.md` for their locations.

## Connect your app

| Generated area | Your connection |
| --- | --- |
| `lib/publisher` | Server ENV and the saved project's placement configuration |
| `lib/auth` | Validate the real request session and return a stable, non-credential session ID |
| `lib/turn-store` | Durable atomic turn storage. The PostgreSQL adapter uses your existing pool. Run its `install()` through your normal migration process. |
| `lib/model` | Your existing abortable model request and response stream |
| `WavebirdPlacement` | A reserved slot beside the result, outside the input and scrolling transcript |

The auth, store and model hooks fail closed until connected. Do not replace authorization with `true`. Keep the preference signing secret stable across workers and restarts.

Mount `WavebirdPlacement` with the authenticated user and active conversation IDs. Use its `onReady` callback to retain the ads instance for that surface. Connect the generation request as shown in the [connection examples](generation.md). Keep request headers, body and cancellation from your app.

Use wavebird's consent dialog or your real CMP according to the project's saved consent mode. Do not grant consent from application startup code.

## Check the result

Check visible ads and Test Logs, then No-Fill, denied consent, Stop and a conversation change. An ad failure must not prevent the model result. The complete framework examples are in `examples/next-js` and `examples/next-ts` inside the installed package. Their demonstration model must be replaced with your own.

[Return to setup](../../README.md#javascript-and-typescript) | [Configuration reference](reference.md)
