# Choom notification identity setup

The notification listener needs Windows package identity plus your explicit permission. These artifacts prepare identity for the isolated notification build. They do not alter Windows, trust certificates, register packages or enable notification access automatically.

## Build-time preparation

Windows 10 build19041 or later and the Windows SDK are required. The checked-in values are packageName Choom, applicationId Choom, publisher CN=Choom, version0.1.7.0. Both manifests must keep matching values. A signing certificate must match that publisher exactly. This identity version matches the repackaged 0.1.7 release.

From windows, opt into the executable manifest:

```powershell
$env:CHOOM_IDENTITY = '1'
npm run build
npm run tauri build -- --no-bundle
Remove-Item Env:CHOOM_IDENTITY
```

build.rs uses Tauri's supported WindowsAttributes.app_manifest API and retains Common Controls v6. Ordinary builds use the default manifest. Deploy the executable as Choom.exe, matching Application@Executable, with its helper resources. The installer maps src-tauri/icons/128x128.png to Assets/storelogo.png under the executable directory so Properties/Logo resolves. VisualElements logos are unused with AppListEntry=none. Do not replace your installed app until the notification build and deployment are approved.

Prepare the unsigned identity package:

```powershell
./identity/prepare.ps1
```

The script discovers MakeAppx in the Windows SDK, copies only AppxManifest.xml into a project-local staging directory, and writes .scratch/identity/Choom.Identity.msix under the checkout root. It never signs or registers. Microsoft requires /nv for an external-location package because visual references resolve against the installation location rather than the package payload.

## Windows changes requiring approval

1. Sign the prepared package with a certificate matching CN=Choom. Keep its private key outside this repository and shared artifacts. For production use a trusted signing certificate. For this local development PC, creating and trusting a development certificate is a separate, explicit security decision. Only its public certificate goes in CurrentUser/TrustedPeople. Never expose a PFX password in command history, logs or a brief.
2. Deploy the audited identity-enabled executable and matching resources to an approved location as Choom.exe. Close the running app before replacement and preserve a rollback copy.
3. Register the signed identity package with the actual application directory:

```powershell
Add-AppxPackage -Path 'C:/absolute/path/Choom.Identity.msix' -ExternalLocation 'C:/absolute/path/to/Choom'
Get-AppxPackage -Name Choom | Select-Object Name, Version, PackageFamilyName
```

ExternalLocation must contain the audited Choom.exe carrying the embedded identity metadata. Registering the package alone cannot give an older installed executable identity. Registration does not grant notification access.

4. Restart that executable, open Settings, then Wake and Notifications, click Turn on notifications and accept the Windows permission prompt yourself. Choose VIP apps from observed notifications. Then send one real Windows toast from an app, check the quiet list, make that app VIP and send another toast to verify four seconds and restoration. Simulated fixtures do not establish live access.

## Rollback

First turn notifications off and close Choom. Remove only this package after verifying its exact name:

```powershell
Get-AppxPackage -Name Choom | Remove-AppxPackage
```

Restore the backed-up executable/resources. If a development certificate was added solely for this setup, remove only that exact recorded certificate thumbprint from CurrentUser/TrustedPeople with separate approval. Never delete unrelated certificates.

## Validation and limits

The manifest and package preparation are tested locally. Signing, trust, deployment, registration and a real toast remain unverified until approved and performed. The access probe distinguishes unsupported, missingIdentity, disabled, unspecified, denied and allowed. Notifications are bounded session memory, never persisted or processed by models. Local dismiss/clear leave Windows notifications intact. Reply, snooze, retry and toast action execution are unsupported.

Sources: [Microsoft external-location package setup](https://learn.microsoft.com/en-us/windows/apps/desktop/modernize/grant-identity-to-nonpackaged-apps), [Microsoft notification listener](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/notification-listener).
