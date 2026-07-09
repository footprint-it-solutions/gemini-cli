# Adding a new content provider

When you extend Gemini CLI to support a new LLM content provider, you must
implement the `ContentGenerator` interface and register your new provider in the
core services. Doing this correctly prevents UI rendering issues and
authentication loops.

## Bypassing authentication validation

To prevent a new provider from getting trapped in an infinite loop displaying
the login option screen with a broken prompt input, you must explicitly
whitelist the provider's `AuthType` in the CLI's authentication validation
module.

The CLI validates active session credentials on startup. If a custom provider
returns a credentials error because its authentication type isn't recognized,
the UI defaults to presenting the standard Google Sign-In dialog, which locks
the main input prompt.

To whitelist your custom provider, update `packages/cli/src/config/auth.ts`:

1.  Locate `validateAuthMethodWithSettings`.
2.  Add your new `AuthType` (and its string representation) to the initial
    whitelist conditional block:

    ```typescript
    if (
      authMethod === AuthType.LOGIN_WITH_GOOGLE ||
      methodStr === 'oauth-personal' ||
      // ...
      authMethod === AuthType.MY_CUSTOM_PROVIDER ||
      methodStr === 'my-custom-provider'
    ) {
      return null;
    }
    ```

<!-- prettier-ignore -->
> [!IMPORTANT]
> Failing to register your `AuthType` in `auth.ts` will trigger a
> validation failure. The CLI will interpret this as an unauthenticated state,
> forcing the user into a broken sign-in screen and locking the prompt.
