# Security policy

Maris can read anything on the computer it runs on, and changes things only after the person approves
them. Security problems in that promise matter most.

## Reporting a problem

Please report security problems privately, not in a public issue:
open the repository's **Security** tab on GitHub and choose **Report a vulnerability**
(github.com/MarySueXLsD/Maris-Local-AI/security/advisories/new).

Helpful to include: what you did, what happened, the Maris version (Settings → Data and setup) and your
operating system. You get an answer within a week; fixes ship as a new version through Updates & news.

## What counts

- Anything that lets Maris change files, settings or programs, or run commands, **without** the
  person's approval (or outside the "Always approve" rules they turned on).
- Ways for a web page, a file, a skill or a connector to make Maris act against the person
  (prompt injection that leads to an unapproved action).
- The phone link: pairing without the code, reading or replaying traffic, approving from a phone when
  that is switched off.
- Keys and tokens leaving the system keychain, or being shown again.
- The terminal command or the installer doing more than they describe.

## Supported versions

Only the newest version gets fixes. Maris checks for it in Updates & news.

## Downloads

Builds come only from this repository's releases. Each release lists the SHA-256 of every file
(`SHA256SUMS-*.txt`); `Get-FileHash <file>` (Windows) or `shasum -a 256 <file>` (macOS, Linux) shows a
download's fingerprint to compare. See docs/signing-and-antivirus.md about signatures and antivirus
warnings.
