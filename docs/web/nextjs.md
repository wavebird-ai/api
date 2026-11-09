# Next.js generator

Use this path instead of copying Dashboard's route files. It supports an existing Next.js App Router app with JavaScript or TypeScript. Use the saved Dashboard configuration in either path.

## Generate files

From the folder containing `package.json`:

```sh
npm install @wavebirdai/api@0.1.0-beta.14 server-only
./node_modules/.bin/wavebird-next init --lang ts --root . --app-dir src/app
```

For JavaScript, use `--lang js`. For a root-level `app/` directory, use `--app-dir app`. The generator does not overwrite existing files. Read the generated `WAVEBIRD-SETUP.md` for their locations.

`server-only` marks backend modules and is required by these examples. If you use the PostgreSQL adapter, install `pg` in your app too.

### If a file already exists

Keep your existing file. Create a temporary sibling folder with an empty `app/` directory, then run the installed generator with `--root ../wavebird-staging --app-dir app` (replace the folder name as needed). Review the generated files there and merge the connections into your app. Keep your existing authentication, model and generation route. If you move a helper into `lib/wavebird/`, update its relative imports and the routes that use it. Do not run the template model or authorization stub unchanged. No existing app files need to be deleted or overwritten.

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

[Return to setup](../../README.md#set-up-javascript-or-typescript) | [Configuration reference](reference.md)
