# Signing Maris and getting antivirus programs to trust it

Norton, Microsoft Defender SmartScreen and other security programs judge a new program mostly by
**reputation**: who published it (its digital signature) and how many people already run it. A fresh,
unsigned build that few people have downloaded is "unknown", so Norton's Download Insight says
*Suspicious file* and sends a copy to its lab, as it did with `Uninstall Maris.exe`. This is not a
virus finding. It means Norton does not know the file yet, and it usually clears once the lab has
looked at it.

There are three things that help: what the build already does, signing the program, and reporting
false alarms. Signing is the one that makes the biggest difference.

## 1. What every build already does

- **Publisher details in every file.** `Maris.exe`, the installer, the uninstaller and the terminal
  launcher `bin\maris.exe` all carry the product name, version, company and copyright (Explorer →
  Properties → Details). The installer also writes the publisher, version, size, homepage and help
  links into Windows' list of installed apps.
- **No administrator rights.** Maris installs for the current user only and never asks for elevation.
  The launcher has a manifest that says so (`asInvoker`).
- **No hidden PowerShell.** The terminal command used to start Maris in the background, and to change
  PATH, through PowerShell with the execution policy bypassed, a pattern security software rightly
  watches. The launcher now does both itself (`--maris-start`, `--maris-path`).
- **Everything is undone on uninstall**: PATH entry, folder menu, startup entry, shortcuts.
- **Checksums.** `node scripts/checksums.cjs release/windows` writes `SHA256SUMS-windows.txt` with
  the SHA-256 fingerprint of each file; the release workflow does it for every build.

## 2. Sign the program (the real fix)

A signed program shows **MarySue** (or your company) as the publisher instead of "Unknown publisher",
and its reputation then belongs to you: it carries over to every new version instead of starting from
zero with each build. electron-builder signs everything (`Maris.exe`, `bin\maris.exe`, the installer
and the uninstaller) as soon as it finds a certificate.

Since June 2023, code-signing keys must live on a hardware token or in a cloud service, so a
certificate is no longer just a `.pfx` file you buy and download. Options for one person:

| Option | Cost | Notes |
| --- | --- | --- |
| [SignPath Foundation](https://signpath.org) | Free for open-source projects | The source must be public under an open-source licence and built by GitHub Actions; files are signed by "SignPath Foundation" on your behalf. |
| [Certum Open Source Code Signing](https://shop.certum.eu) | Tens of euros a year | For individual open-source developers in most countries; identity check, then the key is in Certum's cloud (SimplySign) or on a card. |
| [Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/) (formerly Trusted Signing) | A few dollars a month | Microsoft's own service; check whether it is open to individuals in your country. |
| A standard (OV) certificate from Sectigo, DigiCert, GlobalSign or a reseller | About 200–400 USD a year | Delivered on a USB token or as a cloud key. |

### Plug the certificate into the build

- **A `.pfx` file** (or one exported from a token that allows it): set these before `npm run dist`,
  or as repository secrets of the same names for the GitHub workflow (it already passes them on):

  ```powershell
  $env:WIN_CSC_LINK = 'C:\path\to\certificate.pfx'   # or the file's contents in base64
  $env:WIN_CSC_KEY_PASSWORD = 'the password'
  npm run dist
  ```

- **Azure Artifact Signing**: add this to `win:` in `electron-builder.yml` and sign in with the Azure
  CLI (or set `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`):

  ```yaml
  azureSignOptions:
    publisherName: MarySue
    endpoint: https://weu.codesigning.azure.net
    codeSigningAccountName: your-account
    certificateProfileName: your-profile
  ```

- **A cloud key with its own signing tool** (Certum SimplySign, a USB token): install the vendor's
  tool, then point electron-builder at a small script with `win.signtoolOptions.sign`
  (see electron-builder's "Code signing" page).

Check a signed build with `Get-AuthenticodeSignature release\windows\Maris-Setup-<version>.exe`; it
should say `Valid`.

## 3. Report false alarms

Each vendor has a form for software publishers. Upload the installer (and the flagged file, for example
`Uninstall Maris.exe` from `C:\Program Files\Maris` or from `release\windows\win-unpacked`), say it is
your own open-source program, and include the SHA-256 from `SHA256SUMS-windows.txt`. Answers usually
take a day or two, and a cleared file stays cleared. Every new unsigned build has a new fingerprint,
so it may need reporting again; a signed one keeps your reputation.

- Norton (Gen Digital): [submit.norton.com](https://submit.norton.com/?type=FP), "false positive"
- Avast and AVG (also Gen Digital): [avast.com/false-positive-file-form.php](https://www.avast.com/false-positive-file-form.php)
- Microsoft Defender: [microsoft.com/wdsi/filesubmission](https://www.microsoft.com/en-us/wdsi/filesubmission), as a software developer
- Kaspersky: [opentip.kaspersky.com](https://opentip.kaspersky.com/), then "Request reanalysis"
- To see which programs flag a file at all: [virustotal.com](https://www.virustotal.com/)

Do not add Maris to your antivirus's exclusions to make the warning go away. Reporting it fixes the
warning for everyone, and an exclusion only hides it on one PC.
