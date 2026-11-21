# Google Sheets reader: one-time setup

The app reads Snoonu's **Daily Report** with the Google account that Snoonu shared it with
(viewer access is enough). It asks Google for one permission only: **read spreadsheets**
(`https://www.googleapis.com/auth/spreadsheets.readonly`). It can never change or delete
anything in Google.

You do this once. It takes about 15 minutes. Use the **same Google account** that can open
the Snoonu sheet, or another account that you own (then the Snoonu sheet must also be shared
with that account).

What you get at the end: a **client id** and a **client secret**. They go in the `.env` file
on the server, never in git and never in a chat or email.

---

## A. Create the Google Cloud project

1. Open <https://console.cloud.google.com/> and sign in with the Google account.
2. If asked, accept the Google Cloud terms. No billing account and no payment card are
   needed for the Sheets API at this size.
3. At the top left, click the **project picker** (next to "Google Cloud"), then **New project**.
4. Project name: `Fibrex sheets reader`. Organisation / location: leave as "No organisation".
   Click **Create**.
5. When it is ready, open the project picker again and **select** `Fibrex sheets reader`.
   Check that its name shows at the top before you continue.

## B. Enable the Google Sheets API

6. In the search bar at the top, type `Google Sheets API` and open it (it is under
   "Marketplace" / "APIs").
7. Click **Enable**. Wait until the page shows "API enabled".

If you skip this, the app's **Test headers** says "The Google Sheets API is not enabled in
the Google Cloud project".

## C. Configure the consent screen (Google Auth Platform)

8. Open the menu (☰) > **APIs & Services** > **OAuth consent screen**. Google may call this
   section **Google Auth Platform**. If it shows **Get started**, click it.
9. **App information**: App name `Fibrex`, User support email: your email. Click **Next**.
10. **Audience**: choose **External** (a personal Gmail account cannot choose Internal).
    Click **Next**.
11. **Contact information**: your email. Click **Next**.
12. Tick the agreement to the Google API Services User Data Policy, click **Continue**, then
    **Create**.
13. Open **Data Access** (left menu) > **Add or remove scopes**. In "Manually add scopes"
    paste:

    ```
    https://www.googleapis.com/auth/spreadsheets.readonly
    ```

    Click **Add to table**, make sure only this scope is ticked, click **Update**, then
    **Save**. Do **not** add `.../auth/spreadsheets` (without `.readonly`) or any Drive scope;
    the app refuses a grant that has more than read-only access.
14. Open **Audience** (left menu). Under "Publishing status" click **Publish app**, then
    **Confirm**. The status must now say **In production**.

    Why this matters: while the app is in **Testing**, Google cancels the saved access every
    **7 days** and the morning sync stops. In production it stays until someone removes it.

    Google will not review the app (it is only for your own account). That is fine: when you
    connect (step 22) Google shows "Google hasn't verified this app". Click **Advanced**, then
    **Go to Fibrex (unsafe)**. This is expected for a private app; only you use it.

## D. Create the OAuth client

15. Open **Clients** (left menu of Google Auth Platform, or **APIs & Services** >
    **Credentials** > **Create credentials** > **OAuth client ID**). Click **Create client**.
16. Application type: **Web application**. Name: `Fibrex web`.
17. Under **Authorised redirect URIs** click **Add URI** and enter exactly (no space, no
    trailing slash):

    ```
    http://localhost:5173/settings/google-connection/callback
    ```

    When the app later runs on its real address, come back to this client and **add** a
    second URI with that address, for example:

    ```
    https://app.example.com/settings/google-connection/callback
    ```

    Leave **Authorised JavaScript origins** empty; it is not used.
18. Click **Create**. A box shows the **Client ID** and the **Client secret**. Copy both now
    (you can also download the JSON; keep that file outside the project folder and delete it
    once the values are in `.env`). If the secret is ever shown to someone else, open the
    client, add a new secret, put it in `.env`, then delete the old one.

## E. Put the values in `.env`

19. On the computer that runs the API, open the `.env` file in the project folder (the one
    copied from `.env.example`; it is never committed). Fill in:

    ```
    GOOGLE_OAUTH_CLIENT_ID=<the Client ID, ends with .apps.googleusercontent.com>
    GOOGLE_OAUTH_CLIENT_SECRET=<the Client secret>
    GOOGLE_OAUTH_REDIRECT_URI=
    ```

    Leave `GOOGLE_OAUTH_REDIRECT_URI` empty while you run locally: the app then uses
    `WEB_BASE_URL` + `/settings/google-connection/callback`, which is the URI from step 17.
    On the real server set it to the exact production URI you added in step 17.
20. Restart the API (stop it and run it again) so it reads the new values.

## F. Connect and test in the app

21. Sign in to the app as an admin. Open **Performance** > **Google connection**. The status
    says **Not connected** (if it says "Not set up on the server", step 19 or 20 is missing).
22. Click **Connect Google**, choose the Google account, pass the "not verified" warning
    (step 14), and allow **"See all your Google Sheets spreadsheets"**. That is the
    read-only permission; nothing else is asked for.
23. You come back to the app and the status says **Connected**.
24. Under **Test read**, paste the Snoonu sheet's address from the browser and keep the tab
    `Daily Report`. Click **Test headers**. You should see the column headers of row 3
    (Public ID, Name, Company, ...).
25. Open **Performance** > **Sync sources** > **Add source**: platform Snoonu, kind Google
    Sheet, paste the same address, tab `Daily Report`, schedule `0 4 * * *`, time zone
    `Asia/Qatar`. Save, then click **Test headers** on the row.

From now on the sheet is read every day at 04:00 Qatar time.

---

## When something goes wrong

| What the app says | What to do |
| --- | --- |
| **Reconnect needed** / "Google access ... was revoked or has expired" (admins also get an alert) | Open Google connection and click **Reconnect**. Until then, upload the day's Excel file (download the sheet as .xlsx) so no day is lost. If it happens again after about 7 days, step 14 was not done: the app is still in Testing. |
| "The spreadsheet is not shared with the connected Google account" | Ask Snoonu to share the sheet with that account (viewer), or reconnect with the account that already has access. Check that the address or id is the right sheet. |
| "The Google Sheets API is not enabled" | Do step 7 in the same project as the OAuth client. |
| "... shows #REF! ... IMPORTRANGE link ... is broken" or "still loading" | The Daily Report tab copies data from Snoonu's master sheet and that link failed. The app tries again later and never stores zeros for it. If it lasts, ask Snoonu to check the sheet, and upload the day's Excel meanwhile. |
| "Google Sheets is refusing requests for now (quota ...)" | Nothing to do; the run is tried again automatically. |
| "redirect_uri_mismatch" on Google's page | The address in step 17 must match `GOOGLE_OAUTH_REDIRECT_URI` (or `WEB_BASE_URL` + `/settings/google-connection/callback`) exactly, including `http`/`https` and the port. |

To stop the app reading Google at any time: **Disconnect** on the Google connection page,
or remove "Fibrex" under your Google Account > **Security** > **Your connections to
third-party apps & services**.
