# Apple App Store + iOS/macOS/visionOS — Research

> Compiled 2026-05-02. [NEW] = past 30 days; [STABLE] = older but current.

## knowledge[]-ready facts (32)

1. Apple ships across iOS, iPadOS, macOS, watchOS, tvOS, and visionOS — visionOS 26 launched September 15, 2025 with its own App Store; visionOS 26 added spatial widgets, generative spatial photos, and spatial Safari.
2. Apple Developer Program costs $99/year (individual or organization) and is required for App Store distribution, TestFlight, push, and CloudKit production.
3. Apple Developer Enterprise Program costs $299/year and is INTERNAL-DISTRIBUTION ONLY — it cannot ship to the App Store and misuse leads to revocation.
4. A free Apple ID can build to your own device for 7 days at a time but cannot distribute via App Store, TestFlight, or push notifications.
5. Apple Developer Program requires Apple ID + 2FA + a Mac running Xcode — there is no Linux or Windows path.
6. Xcode 17 ships with Swift 6.2 baked in, file-level dependency tracking for faster incremental builds, and explicit modules — Swift 6.2 adds Inline Arrays for compile-time-optimized fixed-size arrays.
7. SwiftUI is the default for new apps in 2026 and covers iOS, iPadOS, macOS, watchOS, tvOS, and visionOS from one codebase; UIKit/AppKit are still used for advanced cases via UIViewControllerRepresentable.
8. Swift Package Manager is the default dependency manager — CocoaPods is unmaintained as of 2024 and Carthage is EOL.
9. Combine is in maintenance — new code uses Swift Concurrency: async/await, actors, AsyncSequence.
10. App Store Connect at appstoreconnect.apple.com handles bundle IDs, certs, profiles, metadata, screenshots per device class, privacy nutrition labels, and the age rating questionnaire.
11. Xcode Automatically Manage Signing handles distribution certs and provisioning profiles for most teams — manual signing is mainly for shared CI; Fastlane Match is the standard for syncing certs via encrypted Git.
12. TestFlight allows up to 100 internal testers (no review) and up to 10,000 external testers (Beta App Review required) with 90-day build expiration.
13. App Store review times average under 24 hours for ~90% of submissions in 2026 — expedited review is granted selectively for critical bugs, security issues, or fixed-date launches.
14. App Store Review Guidelines have 5 sections — Safety, Performance, Business, Design, Legal — and the most-cited rejection reasons are 5.1.1 (privacy policy), 2.1 (completeness/crashes), 4.3 (design spam), and 5.1.2 (data use mismatch).
15. Guideline 3.1.1 requires Apple In-App Purchase for digital goods and services with carve-outs for Reader Apps, physical goods, multiplatform services, and (since the 2026 US ruling) external payment links on the US storefront.
16. StoreKit 2 is the modern Swift API with Product, Transaction, VerificationResult, AppStore.sync(), and Transaction.updates — server-to-server notifications V2 are JWS-signed and authoritative for billing state.
17. Win-back offers (iOS 18+) automatically re-engage lapsed subscribers via Apple-hosted offers in the App Store with no extra app code beyond StoreKit 2.
18. Standard App Store commission is 30% but drops to 15% after Year 2 of an auto-renewable subscription and 15% flat under the Small Business Program for developers under $1M annual proceeds.
19. Privacy Manifests (PrivacyInfo.xcprivacy) have been required since May 1, 2024 — they declare collected data, tracking domains, and Required Reason API usage for UserDefaults, FileTimestamp, SystemBootTime, DiskSpace, and ActiveKeyboards.
20. 86 listed third-party SDKs (Firebase, Adjust, Sentry, Stripe, etc.) MUST ship with privacy manifest + valid code signature when added as a binary dependency — missing either causes App Store rejection.
21. Apple's Foundation Models framework (iOS 26+) provides a free on-device ~3B-parameter LLM with the @Generable macro for type-safe constrained decoding — runs offline on Apple Silicon Neural Engine.
22. App Intents framework declares actions Siri, Spotlight, Shortcuts, and Apple Intelligence Visual Intelligence can invoke — required to integrate with new system AI surfaces.
23. EU DMA: as of January 1, 2026, the per-install Core Technology Fee was replaced by a Core Technology Commission of 5% plus a 2% Initial Acquisition Fee and a 5–13% Store Services Fee.
24. EU alternative app marketplaces include AltStore PAL, Setapp Mobile, and Epic Games Store on iOS — apps distributed there require Apple notarization (technical scan, not editorial review).
25. Mac apps can ship via Mac App Store (sandboxed, full review) OR Developer ID + Notary Service for direct distribution outside the store — both REQUIRE notarization since macOS Catalina.
26. macOS apps must be Universal binaries (arm64;x86_64) but Apple Silicon is the priority — Intel macOS support is winding down through macOS 26.
27. visionOS apps come in three patterns — Window (flat 2D), Volume (bounded 3D via WindowGroup volumetric), and Immersive Space (full mixed/full-immersion via RealityKit + ARKit).
28. iPad apps are auto-listed as 'Compatible with Apple Vision Pro' unless explicitly opted out in App Store Connect.
29. From April 28, 2026, App Store submissions REQUIRE iOS/iPadOS/tvOS/visionOS/watchOS 26 SDK or later, and watchOS apps require 64-bit support — older SDKs are rejected at upload.
30. April 2026 guideline updates added external-payment-link compliance for US storefront (3.1.1, 3.1.3), creator-app age-verification requirement, 36% APR cap on loan apps, and a ban on using another developer's icon/brand/name in your own.
31. Receipt validation for subscriptions MUST be done server-side with the App Store Server API and S2S notifications V2 — on-device verification can be bypassed on jailbroken devices and is not authoritative.
32. App Tracking Transparency (ATT) requires calling ATTrackingManager.requestTrackingAuthorization with NSUserTrackingUsageDescription in Info.plist BEFORE setting IDFA or sharing identity-linked data with other companies — tracking when denied is grounds for 5.1.2 rejection.
