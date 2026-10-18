# Appwrite infrastructure

`npm run deploy` enables email-OTP auth, disables magic-link, password, and anonymous auth,
allows profile team members to see each other's user ID, email, and name,
registers web and Android platforms, and installs the row-secured profiles and
telemetry tables, the project-scoped Time Series
Store, event-driven MQTT Function, static Next.js Site, variables, and domains.
Authenticated users create profile teams and rows from the mobile
Settings screen; each profile team controls access to its devices and telemetry.
The local profile UUID is reused as both the Appwrite Team ID and profile row
ID, making mobile reconciliation idempotent across restarts.
Devices and MQTT credentials use Appwrite's built-in per-project Devices API.
The Appwrite CLI honors the deployment directory's `.gitignore`; both `site/`
and `function/` exclude local `node_modules/` so dependencies are installed by
the configured remote `npm ci` command instead of uploaded.

This changes remote state. Use `npm run check` for local syntax validation.

`npm run clean` removes the resources with this template's deterministic IDs:
the Site and its proxy rule, MQTT Function, database with profiles and telemetry,
and web/local/Android auth platforms. It does not delete profile teams, project users, Appwrite Devices, or
change project-wide authentication methods. To inspect the commands without
changing Appwrite, run `INFRA_DRY_RUN=1 npm run clean`.
