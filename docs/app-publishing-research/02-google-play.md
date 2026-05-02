# Google Play + Android — Research

> Compiled 2026-05-02. [NEW] = past 30 days; [STABLE] = older but current.

## knowledge[]-ready facts (30)

1. Google Play developer registration is a $25 USD ONE-TIME fee — not annual — versus Apple's $99/year.
2. Personal Google Play accounts created after Nov 2023 must run Closed Testing with at least 12 opted-in testers for 14 continuous days before applying for Production access; verified Organization accounts with a DUNS number are exempt.
3. As of April 2026, Google now measures real User Engagement Time during Closed Testing; inactive testers are flagged and don't count toward the 12.
4. Organization Google Play accounts require a Dun & Bradstreet DUNS number, with legal name and address matching the Google Payments profile exactly — no exemptions.
5. Google Play has required Android App Bundle (AAB) for all new app submissions since August 2021; APK is only legal for sideloading and alt stores.
6. Android apps over 200 MB must use Play Asset Delivery (PAD) with install-time, fast-follow, or on-demand modes, replacing the legacy OBB system.
7. Since Aug 31, 2025, Google Play requires new apps and updates to target Android 15 / API 35; Wear OS, Android Automotive OS, and Android TV may stay at API 34.
8. API 36 (Android 16) is expected to become required around August 2026 following Google Play's annual targetSdkVersion cadence.
9. Android Gradle Plugin 9.1.1 (April 2026) is current stable and requires Gradle 9.1.0, JDK 17, and supports compileSdk up to API 36.
10. Android Studio Quail 2026.1.1 is the active 2026 release; the lineage runs Ladybug → Meerkat → Narwhal → Quail.
11. Kotlin 2.x is the default Android language in 2026 and Jetpack Compose is now the practical default for new UI work; 60% of the top 1,000 Play apps use Compose.
12. Compose Multiplatform 1.10.0 (Jan 2026) is stable for Android, iOS, and desktop, with the web target in beta — runs on Kotlin Multiplatform.
13. Material 3 Expressive ships 35 new shapes, integrated shape morphing, and 15 new/updated Compose components with emphasized motion and typography.
14. Play Integrity API replaced SafetyNet Attestation, which was fully turned off in January 2025.
15. Play Integrity returns three verdicts: MEETS_BASIC_INTEGRITY, MEETS_DEVICE_INTEGRITY, and MEETS_STRONG_INTEGRITY; on Android 13+ STRONG also requires a security update within the last 12 months.
16. Play Billing Library 8.3.0 (April 2026) is current; 8.2.0 introduced external content links and external offers APIs for DMA compliance.
17. Google Play takes 15% on the first $1M/year of revenue per developer automatically — no separate Small Business Program enrollment required.
18. All Google Play subscriptions are charged 15% from day one since January 1, 2022 — no longer 30% year-1 then 15%.
19. Play App Signing is the default: upload key (RSA ≥ 2048) for uploads, Google holds the signing key; APK signature v3.1 enables safe key rotation on Android 13+.
20. The Play Console feature graphic must be exactly 1024×500 px in JPG or 24-bit PNG with no alpha — mandatory to publish a store listing.
21. Phone screenshots: up to 8, minimum 2, 16:9 or 9:16, 320–3840 px on the long edge; separate sets required per declared form factor.
22. The IARC content rating questionnaire produces ESRB, PEGI, USK, ClassInd, GRAC, ACB, IGRS, and GAMR ratings from one submission.
23. The Data Safety section requires declaring every data type collected, sharing, and purpose; mismatches with actual SDK behavior trigger removal.
24. Pre-launch reports run your AAB on Firebase Test Lab physical devices automatically and flag crashes, ANRs, security issues, and accessibility problems for free.
25. Wear OS 6 supports Material 3 Expressive and Watch Face Format v4; Wear OS apps need <uses-feature android:name='android.hardware.type.watch'/> in the manifest.
26. Android Auto apps are restricted to approved categories (media, messaging, nav, POI, parking, charging, IoT) and require manual Google review against design templates.
27. Gemini Nano runs on-device through Android's AICore system service; Gemma 4 Developer Preview (April 2026) is forward-compatible with Gemini Nano 4.
28. Starting Sep 30, 2026, apps in Brazil, Indonesia, Singapore, and Thailand must be registered by a verified developer to install on certified Android devices — affects sideloading too, with an advanced 24-hour-cooldown flow for power users.
29. The Google Play Developer API v3 uses an Edit pattern: edits.insert → mutate → edits.commit; until commit nothing is published. Fastlane supply covers ~20 of 204 endpoints; gradle-play-publisher and the new GPC CLI cover more.
30. R8 obfuscation is mandatory for release AABs; a missing -keep rule for reflection/Gson/Retrofit silently breaks release while debug works — always test the release AAB locally with bundletool before upload.
