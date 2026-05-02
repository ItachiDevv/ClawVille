# Microsoft Store + Windows app dev — Research

> Compiled 2026-05-02. [NEW] = past 30 days; [STABLE] = older but current.

## knowledge[]-ready facts (30)

1. Microsoft Store individual developer accounts have been free worldwide since September 2025 — no $19 fee, just government ID + selfie identity verification.
2. Microsoft Store company/organization developer accounts still cost $99 one-time as of May 2026; the fee waiver only applied to individual accounts.
3. Microsoft Store revenue split is 85/15 for non-gaming apps using Microsoft's commerce engine, 88/12 for games, and 100/0 if a non-gaming app uses its own commerce engine like Stripe or Paddle.
4. The 100/0 own-commerce revenue carve-out does NOT apply to games on the Microsoft Store — games always pay the 12% cut regardless of payment processor.
5. Windows App SDK 2.0 went GA in May 2026 with WinUI 3 Gallery 2.9 as the first reference app; 2.0 requires .NET 10 and standardizes on SemVer 2.0.0.
6. WinUI 3 + Windows App SDK is Microsoft's recommended modern framework for new Windows desktop apps as of 2026; UWP is deprecated for new development.
7. .NET MAUI 10.0.30 ships with .NET 10 (current stable May 2026); MAUI 11 ships with .NET 11 in November 2026.
8. Windows 10 reached end of free support on October 14, 2025; Extended Security Updates run through October 13, 2026 ($30/yr for consumers, free if synced to a Microsoft account).
9. Windows 11 26H1 is a special targeted release for Qualcomm Snapdragon X2 Series devices only and is NOT a publishing baseline — devices on 26H1 cannot upgrade to the next H2 release.
10. HoloLens 2 production ended in October 2024; software security updates only run through December 31, 2027 — do not start new HoloLens development.
11. Windows Subsystem for Android was sunset on March 5, 2025; the Amazon Appstore for Windows is delisted and WSA is not a viable distribution path.
12. Copilot+ PC requirements are an NPU of at least 40 TOPS, 16 GB RAM, 256 GB SSD, and Windows 11 24H2 or newer; current silicon: Intel Core Ultra 200V (48 TOPS), AMD Ryzen AI 300 (50 TOPS), Qualcomm Snapdragon X (45+ TOPS).
13. Phi Silica is Microsoft's NPU-resident on-device LLM available on Copilot+ PCs through Windows AI Foundry APIs; the April 2026 update (1.2604.515.0) ships across Intel, AMD, and Qualcomm Copilot+ hardware.
14. Windows AI Foundry exposes Phi Silica directly inside the Windows App SDK so apps can call summarization, rewrite, and short-form generation locally with no cloud round-trip.
15. MSIX is the modern Windows package format — atomic install/uninstall, identity-based capability declarations, multi-architecture bundles (x86/x64/ARM64), and required for Microsoft Store distribution.
16. App Installer files (.appinstaller) enable sideload distribution with auto-update from any HTTPS URL or UNC share, and can be embedded inside the MSIX package itself.
17. Microsoft Store certification typically takes 24–72 hours; run the Windows App Certification Kit (WACK) locally first to catch ASLR, manifest, and unsupported-API failures.
18. EV Code Signing certificates ($300–900/yr from DigiCert/Sectigo/SSL.com) bypass Windows SmartScreen reputation immediately; standard OV certs require a slow opaque reputation buildup.
19. As of June 1, 2023, all code-signing certificates require hardware key storage (FIPS 140-2 L2 / CC EAL 4+) — file-based .pfx EV certs are no longer issued; YubiKey 5 FIPS or HSM is required.
20. Microsoft Trusted Signing was renamed Azure Artifact Signing in January 2026; pricing is $9.99/mo for 5,000 signatures or $99.99/mo for 100,000 — but Microsoft has confirmed it will never issue EV-tier certificates.
21. WinGet (Windows Package Manager) is in-box on Windows 11 and modern Windows 10; submit a YAML manifest to github.com/microsoft/winget-pkgs to distribute a free CLI install.
22. WinGet manifest schema v1.12 (April 2026) added Font as an InstallerType with a non-experimental winget-fonts source.
23. The Microsoft Game Development Kit (GDK) shipped its April 2026 release (gdk-2604) with Visual Studio 2026 support, MSIXVC2 packaging preview, and native ARM64 build libraries.
24. GDC 2026 announced Foundation Mode (free Xbox dev-kit access), the Public GDK on GitHub (no NDA), and ID@Xbox onboarding compressed from ~30 days down to ~30 minutes.
25. Microsoft Store policies (v7.19) ban on-device cryptocurrency mining outright; wallet/exchange management apps are allowed but require a Company account, not an Individual account.
26. Beginning April 2026, all Microsoft Partner Center / Store Submission API app+user calls require MFA authentication on the access token — rotate CI tokens accordingly.
27. Tauri 2 uses the in-OS WebView2 on Windows producing ~3 MB hello-world bundles vs Electron's 150 MB+, with roughly 25× smaller bundles and 4× faster startup; the Tauri bundler emits .exe, .msi, and .msix.
28. Sign MSIX packages with: signtool sign /fd sha256 /tr <timestamp-url> /td sha256 /a /f cert.pfx /p <pwd> app.msix — always specify the hash algorithm because SignTool's default SHA1 is rejected by the Store.
29. MSIX manifest targetDeviceFamily=Windows.Desktop is the usual choice for new desktop apps; Windows.Universal silently filters out desktop-only API surface and is rarely what you want.
30. MAUI on Windows uses WinUI 3 under the hood; if you target Windows-only, native WinUI 3 + Windows App SDK is faster and exposes more platform features than going through MAUI.
