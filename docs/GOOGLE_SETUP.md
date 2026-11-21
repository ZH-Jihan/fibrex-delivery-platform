# Google Sheets reader: one-time setup

The app reads Snoonu's **Daily Report** from Google Sheets every morning. It asks Google for
one permission only: **read spreadsheets**
(`https://www.googleapis.com/auth/spreadsheets.readonly`). It can never change or delete
anything in Google.

There are two ways to let the app read the sheet:

| | Route 1: mirror sheet + service account (**recommended**) | Route 2: your Google account (OAuth, alternative) |
| --- | --- | --- |
| How it reads | You keep your own copy of the report (a "mirror sheet" that pulls Snoonu's tab with `IMPORTRANGE`) and share it with the app's **service account** as Viewer | You sign in with your Google account once and allow read-only access |
| Does it expire? | No | **Yes, every 7 days**, because the app cannot be published (no public home page or privacy policy). Someone must click **Reconnect** each week |
| What goes on the server | A JSON key file, kept outside the project folder | A client id and client secret in `.env` |

Use Route 1. Route 2 stays in the app for emergencies and is described at the end.

---

# Route 1 (recommended): mirror sheet and service account

It takes about 20 minutes. You need the Google account that can open Snoonu's Daily Report.

The service account for this app already exists:

```
fibrex-sheet-reader@fibrex-sheets-reader.iam.gserviceaccount.com
```

(project `fibrex-sheets-reader`). If you ever make a new one, use its address wherever this
page shows the one above. The app's **Google connection** page always shows the address it
uses.

## 1. Enable the Google Sheets API

1. Open <https://console.cloud.google.com/>, sign in, and pick the project
   `fibrex-sheets-reader` in the project picker at the top left. Check that its name shows
   at the top before you continue.
2. In the search bar type `Google Sheets API`, open it, and click **Enable** (if it already
   says "API enabled", nothing to do).

No billing account and no payment card are needed at this size.

## 2. Create the service account (skip if it already exists)

3. Menu (☰) > **IAM & Admin** > **Service accounts**. If `fibrex-sheet-reader` is listed, go
   to step 6.
4. Click **Create service account**. Name `fibrex-sheet-reader`. Click **Create and
   continue**.
5. **Permissions** and **Principals with access**: leave both empty (the account needs no
   project role; it only reads sheets that are shared with it). Click **Done**.

## 3. Create the service account key

6. Click the service account `fibrex-sheet-reader@...`, open the **Keys** tab, click
   **Add key** > **Create new key**, choose **JSON**, click **Create**. Your browser
   downloads a file such as `fibrex-sheets-reader-1a2b3c4d5e6f.json`.
7. This file is a password. Move it **out of the Downloads folder and outside the project
   folder**, to a folder only you use, for example:

   ```
   C:\Fibrex-secrets\google-sheet-reader.json
   ```

   - Never put it inside `C:\Jihan\Fibrex App` (the project), never commit it, never send
     it by email or chat, never paste it into the app. (The project's `.gitignore` refuses
     common key file names and any `secrets/` folder, as a safety net only.)
   - On the real server, put it in a folder readable only by the account that runs the API.
   - If the file is ever exposed: on the **Keys** tab delete that key, create a new one
     (step 6) and point `.env` at the new file.

## 4. Make the mirror sheet

8. Open <https://sheets.google.com/> with your own Google account and create a **blank
   spreadsheet**. Name it `Fibrex mirror - Snoonu Daily Report`.
9. Rename its first tab (double-click `Sheet1` at the bottom) to exactly:

   ```
   Daily Report
   ```

10. Click cell **A1** of that tab and type this formula, with the address of **Snoonu's**
    sheet (copy it from the browser bar while Snoonu's sheet is open):

    ```
    =IMPORTRANGE("https://docs.google.com/spreadsheets/d/SNOONU_SHEET_ID/edit", "'Daily Report'!A1:ZZ2000")
    ```

    Press Enter. The cell shows `#REF!`; hover over it and click **Allow access**. After a
    few seconds the whole Daily Report appears, starting at A1, so the column headers are
    on **row 3**, exactly as in Snoonu's sheet.
11. Do not type, sort, insert rows or columns, or format anything in this tab: the app
    expects Snoonu's layout. (If Snoonu's report ever grows past column ZZ or row 2000,
    widen the range in the formula.)

The app reads this mirror, not Snoonu's sheet directly. While `IMPORTRANGE` is loading or
broken, the tab shows "Loading..." or `#REF!`. The app then treats the sheet as
**unreadable** and tries again later; it never stores those days as zeros.

## 5. Share the mirror sheet with the service account

12. In the mirror sheet click **Share** (top right). Add:

    ```
    fibrex-sheet-reader@fibrex-sheets-reader.iam.gserviceaccount.com
    ```

    Choose **Viewer**, **untick "Notify people"** (a service account has no mailbox), and
    click **Share**. Do not give it Editor.

Snoonu's own sheet does **not** need to be shared with the service account; only your
mirror is.

## 6. Tell the server where the key is

13. On the computer that runs the API, open the `.env` file in the project folder (copied
    from `.env.example`; never committed) and set:

    ```
    GOOGLE_SERVICE_ACCOUNT_KEY_FILE=C:/Fibrex-secrets/google-sheet-reader.json
    GOOGLE_SERVICE_ACCOUNT_KEY_JSON=
    ```

    Use forward slashes in the path. `GOOGLE_SERVICE_ACCOUNT_KEY_JSON` is only for hosting
    where a file is awkward: it takes the whole key JSON on one line instead. Set one of the
    two; if both are set, the file wins.
14. Restart the API (stop it and start it again) so it reads the key.

The key is read only from this file or variable. The app never stores it in the database,
never writes it to a log, and never sends it to the browser; the page shows only the
service account's email address.

## 7. Test in the app

15. Sign in as an admin. Open **Performance** > **Google connection**. Under
    **Service account (recommended)** you should see **Ready** and the address from step 12.
    - "Not set up on the server": step 13 or 14 is missing.
    - "Key not usable": the message says why (file not found at that path, not a JSON key,
      and so on). Fix it and restart the API.
16. Under **Test read**, keep **Sign in with: Service account (recommended)**, paste the
    **mirror sheet's** address, keep the tab `Daily Report`, and click **Test headers**. You
    should see the column headers of row 3 (Public ID, Name, Company, ...).
17. Open **Performance** > **Sync sources** > **Add source**: platform Snoonu, kind Google
    Sheet, **Sign in with: Service account (recommended)**, the mirror sheet's address, tab
    `Daily Report`, schedule `0 4 * * *`, time zone `Asia/Qatar`. Save, then click **Test
    headers** on the row.

From now on the mirror sheet is read every day at 04:00 Qatar time.

---

# Route 2 (alternative): your Google account with OAuth

**Needs a reconnect every 7 days.** Google cancels the access of an app that is in
"Testing" after 7 days, and this app cannot be published (that needs a public home page
and a privacy policy). Use this only if the service account cannot be used. Sources that
were set up this way before the service account existed keep working this way until you
switch them to the service account under **Sync sources** > **Edit**.

What you get at the end: a **client id** and a **client secret**. They go in the `.env` file
on the server, never in git and never in a chat or email.

## A. Project and API

1. Use the same Google Cloud project as Route 1, and do Route 1 section 1 ("Enable the Google
   Sheets API") if it is not done.

## B. Configure the consent screen (Google Auth Platform)

2. Open the menu (☰) > **APIs & Services** > **OAuth consent screen**. Google may call this
   section **Google Auth Platform**. If it shows **Get started**, click it.
3. **App information**: App name `Fibrex`, User support email: your email. Click **Next**.
4. **Audience**: choose **External** (a personal Gmail account cannot choose Internal).
   Click **Next**.
5. **Contact information**: your email. Click **Next**.
6. Tick the agreement to the Google API Services User Data Policy, click **Continue**, then
   **Create**.
7. Open **Data Access** (left menu) > **Add or remove scopes**. In "Manually add scopes"
   paste:

   ```
   https://www.googleapis.com/auth/spreadsheets.readonly
   ```

   Click **Add to table**, make sure only this scope is ticked, click **Update**, then
   **Save**. Do **not** add `.../auth/spreadsheets` (without `.readonly`) or any Drive scope;
   the app refuses a grant that has more than read-only access.
8. Open **Audience** (left menu) > **Test users** > **Add users** and add the Google account
   that can open the sheet. The app stays in **Testing**, so its access ends after 7 days.

## C. Create the OAuth client

9. Open **Clients** (left menu of Google Auth Platform, or **APIs & Services** >
   **Credentials** > **Create credentials** > **OAuth client ID**). Click **Create client**.
10. Application type: **Web application**. Name: `Fibrex web`.
11. Under **Authorised redirect URIs** click **Add URI** and enter exactly (no space, no
    trailing slash):

    ```
    http://localhost:5173/settings/google-connection/callback
    ```

    When the app later runs on its real address, come back to this client and **add** a
    second URI with that address, for example
    `https://app.example.com/settings/google-connection/callback`. Leave **Authorised
    JavaScript origins** empty.
12. Click **Create** and copy the **Client ID** and the **Client secret**. If you download
    the JSON, keep it outside the project folder and delete it once the values are in
    `.env`. If the secret is ever exposed, add a new secret to the client, put it in `.env`,
    then delete the old one.

## D. Put the values in `.env`

13. In `.env` on the computer that runs the API:

    ```
    GOOGLE_OAUTH_CLIENT_ID=<the Client ID, ends with .apps.googleusercontent.com>
    GOOGLE_OAUTH_CLIENT_SECRET=<the Client secret>
    GOOGLE_OAUTH_REDIRECT_URI=
    ```

    Leave `GOOGLE_OAUTH_REDIRECT_URI` empty while you run locally: the app then uses
    `WEB_BASE_URL` + `/settings/google-connection/callback`, the URI from step 11. On the
    real server set it to the exact production URI you added in step 11.
14. Restart the API.

## E. Connect and test

15. **Performance** > **Google connection**. Under **Google account (alternative)** click
    **Connect Google**, choose the account, pass the "Google hasn't verified this app"
    warning (**Advanced** > **Go to Fibrex (unsafe)**; expected for a private app), and allow
    **"See all your Google Sheets spreadsheets"**, the read-only permission.
16. Back in the app the status says **Connected**. Under **Test read** choose **Sign in
    with: Google account (OAuth)**, paste the sheet's address and click **Test headers**.
17. In **Sync sources**, a source that should use this route must say **Sign in with:
    Google account (OAuth)**.
18. About every 7 days the status turns to **Reconnect needed** and admins get an alert:
    click **Reconnect** and sign in again.

---

## When something goes wrong

| What the app says | What to do |
| --- | --- |
| "The spreadsheet is not shared with the service account fibrex-sheet-reader@..." | Share the **mirror** sheet with that exact address as Viewer (Route 1 step 12). Check that the source points at the mirror, not at Snoonu's sheet. |
| "No spreadsheet with this id, or it is not shared with the service account ..." | Check the spreadsheet address of the source; then share as above. |
| "The server has no Google service account key" / "Not set up on the server" | Set `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` (Route 1 step 13) and restart the API. |
| "Key not usable" / "... key file ... cannot be read" / "... not valid JSON" | The path in `.env` is wrong or the file is not the JSON key from Route 1 step 6. Fix it and restart the API. |
| "Google refused the service account key ... (invalid_grant)" (admins also get an alert) | The key was deleted or disabled, the service account was removed, or this computer's clock is wrong. Check the clock, otherwise create a new key (Route 1 step 6) and point `.env` at it. Until then, upload the day's Excel file. |
| "... shows #REF! ... IMPORTRANGE link ... is broken" or "still loading" | The mirror's `IMPORTRANGE` cannot reach Snoonu's sheet. Open the mirror: if A1 says `#REF!`, click it and **Allow access**; if Snoonu removed your access, ask them to share again. The app tries again later and never stores zeros for it. Meanwhile, upload the day's Excel file. |
| "The Google Sheets API is not enabled" | Do Route 1 section 1 ("Enable the Google Sheets API") in the project that holds the service account (or the OAuth client). |
| "Google Sheets is refusing requests for now (quota ...)" | Nothing to do; the run is tried again automatically. |
| **Reconnect needed** / "Google access ... was revoked or has expired" (OAuth sources only) | Expected about every 7 days on Route 2. Click **Reconnect**, or move the source to the service account (Route 1). Until then, upload the day's Excel file. |
| "The spreadsheet is not shared with the connected Google account" (OAuth sources only) | Reconnect with the account that can open the sheet, or ask Snoonu to share it with that account. |
| "redirect_uri_mismatch" on Google's page (OAuth only) | The address in Route 2 step 11 must match `GOOGLE_OAUTH_REDIRECT_URI` (or `WEB_BASE_URL` + `/settings/google-connection/callback`) exactly, including `http`/`https` and the port. |

To stop the app reading Google at any time:

- Route 1: remove the service account from the mirror sheet's **Share** list, or delete
  its key under **Keys** in Google Cloud.
- Route 2: **Disconnect** on the Google connection page, or remove "Fibrex" under your
  Google Account > **Security** > **Your connections to third-party apps & services**.
