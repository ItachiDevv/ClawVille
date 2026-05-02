# Cross-platform frameworks + alt app stores — Research

> Compiled 2026-05-02. [NEW] = past 30 days; [STABLE] = older but current.

## knowledge[]-ready facts (30)

1. React Native 0.85 (April 2026) added a unified animation backend so layout props like width, height, flex, and position now run on the native driver.
2. React Native 0.84 (Feb 2026) made Hermes V1 the default JS engine — about 30% less memory and faster cold starts.
3. Expo SDK 55 dropped the Legacy Architecture entirely; the New Architecture is now mandatory and OTA updates are 75% smaller via Hermes bytecode diffing.
4. EAS Build is the recommended cloud build path for Expo/React Native apps — iOS builds run on Expo's macOS cloud, Android builds on GCP Linux runners.
5. Flutter 3.41 with Dart 3.11 shipped February 2026; Flutter 2026 roadmap commits to four stable + twelve beta releases.
6. Flutter's Impeller renderer is now default on Android API 29+ in 2026 and the legacy Skia backend is being removed.
7. Tauri 2 uses the OS native webview instead of bundled Chromium — bundles run 2-10MB versus Electron's 100MB+.
8. Tauri 2.11.0 (March 2026) is the current release and ships stable iOS + Android mobile targets with Hot Module Reload to device emulators.
9. Capacitor 8 made Swift Package Manager the default iOS dependency manager, replacing CocoaPods for new projects; latest is 8.3.1 from April 2026.
10. Compose Multiplatform 1.8.0 (May 2025) made iOS UI sharing officially Stable and production-ready alongside Android.
11. Kotlin 2.2.20 introduced direct Swift export (no Objective-C bridge); JetBrains is targeting stable Swift interop in 2026.
12. .NET 11 GA is scheduled for November 2026 and makes CoreCLR the default runtime for MAUI Release builds, improving startup at a small size cost.
13. Apple's EU Core Technology Fee was fully replaced by the Core Technology Commission on January 1, 2026 — the new fee stack runs 10% best case to 20% worst case.
14. EU iOS alternative marketplaces in 2026 are AltStore PAL, Epic Games Store, and Aptoide — Setapp Mobile closed February 16, 2026.
15. Apple Web Distribution lets EU developers ship iOS apps from their own website, but only if their app had over 1 million EU installs in the prior year — about 90% of devs are excluded.
16. Google's Android Developer Verifier rolls out April 2026, with the global sideload 'advanced flow' arriving August 2026 — F-Droid, Samsung, Aurora, Huawei, Xiaomi must push devs through verification.
17. Itch.io uses an open revenue-share slider from 0% to 100% with 10% default — the de-facto indie game and jam launchpad with 900,000+ projects.
18. Epic Games Store now lets developers keep 100% of the first $1M per product per year, then reverts to the standard 88/12 split.
19. Huawei AppGallery has roughly 325M monthly active users and over 350,000 HarmonyOS apps as of late 2025; required for Huawei devices in China and EMEA.
20. Flathub (community Flatpak) hosts 9,000+ Linux apps in 2026 and supports multiple stores; Snap Store is Canonical-only and supports 41 distros.
21. Microsoft App Center is sunsetting — Crashes/Analytics/Diagnostics support ends June 30, 2026; Microsoft recommends migrating to Sentry, Crashlytics, BugSnag, or Datadog.
22. Sentry, PostHog, and Firebase Crashlytics are the dominant cross-platform crash and analytics stack in 2026 — PostHog added native error tracking in 2024 to compete with Sentry.
23. Fastlane's match (cert sync) and gym (build) are still the dominant iOS+Android signing and packaging automation; the gradle action handles Android builds.
24. Microsoft Store re-signs MSIX packages for free at certification time, so Store-only apps don't need to buy a code-signing cert.
25. Azure Trusted Signing (Microsoft, $9.99/mo) is the recommended hosted alternative to a $400+/yr EV cert for Windows apps distributed outside the Store.
26. From March 1, 2026 the CA/Browser Forum caps publicly-trusted code-signing certificates at 458 days max validity — plan rotation accordingly.
27. iOS 26 makes every Home-Screen-added site default to opening as a web app, but in the EU Apple stripped standalone PWA support and PWAs open in Safari tabs without push.
28. When picking a framework: Tauri 2 for tiny desktop apps, Flutter for pixel-identical UI, React Native + Expo for web-team mobile, Unity/Unreal/Godot for cross-PC-mobile-console games, and .NET MAUI when the team is already on .NET.
29. Cross-platform notification systems require unified abstraction across APNs (Apple) + FCM (Google) + WNS (Windows) + WebPush (browsers) — Firebase Cloud Messaging or OneSignal usually wrap them all.
30. Age ratings differ per region — IARC produces a unified questionnaire that auto-generates ESRB (US), PEGI (EU), USK (Germany), ACB (Australia), GRAC (Korea), CERO (Japan), and others from one submission.
