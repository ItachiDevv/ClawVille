# Steam (Valve) + Steamworks SDK — Research

> Compiled 2026-05-02. [NEW] = past 30 days; [STABLE] = older but current.

## knowledge[]-ready facts (27)

1. Steam is the dominant PC games store, hitting an all-time concurrent-user record of 42,042,778 on January 11, 2026, with monthly active users around 147 million and daily active users around 69 million.
2. Publishing on Steam costs a one-time Steam Direct fee of $100 USD per app, recoupable in the payout after the title earns $1,000 USD in adjusted gross revenue, charged on every new AppID even under the same publisher.
3. Steam's revenue split is tiered per-title-lifetime: 70/30 below $10M, 75/25 between $10M and $50M, 80/20 above $50M, with the dev share charged for the Direct fee recoup.
4. First-time Steam Direct devs face a mandatory 30-day waiting period after onboarding before their first product can release, and the store's 'Coming Soon' page must be live for at least 14 days before launch.
5. Steam's technical compliance review takes 1 to 5 business days for most builds, and the 'set release date' action is one-way without Valve intervention.
6. The Steamworks SDK is native C++ with community wrappers for C# (Steamworks.NET, Facepunch.Steamworks), Rust, Python, Go, Node, and built-in Unreal support via OnlineSubsystemSteam.
7. Steamworks SDK 1.64 shipped March 11 2026, adding ISteamUGC.MarkDownloadedItemAsUnused/GetDownloadedItems and Remote Play Together session-avatar APIs plus ARM64 Linux/Android improvements.
8. Steamworks SDK 1.63 (Nov 2025) added linuxarm64 + androidarm64 libraries and removed the deprecated ISteamMusicRemote interface.
9. Steam achievements and stats are wired via ISteamUserStats: call RequestCurrentStats at session start, await UserStatsReceived_t, then SetAchievement and StoreStats; global completion percent is provided by GetAchievementAchievedPercent.
10. SteamPipe is Valve's content delivery system (since 2013) built on apps containing depots and immutable builds, with branches as named pointers (default, beta, soak-test) that users can opt into via Properties → Betas, optionally with a non-secret password.
11. Steam content uploads are driven by SteamCMD running app_build_<appid>.vdf scripts, which reference per-depot depot_build_<depotid>.vdf scripts describing ContentRoot, file mappings, and exclusions.
12. The 2024 Steam store-asset spec uses Small Capsule 462x174, Header Capsule 920x430, Main Capsule 1232x706, Library Capsule 600x900, Library Hero 3840x1240 (no text, 3000x740 safe area), with at least 5 screenshots at 1920x1080.
13. Steam Deck Verified requires legible text (body ≥12px at 800p), full controller support, default ≥30 FPS at 1280x800, ≥90 minutes of battery, no compatibility warnings, and Proton-supported anti-cheat if applicable.
14. Most Windows games on Steam Deck run via Proton (Wine + DXVK + VKD3D-Proton); Proton Experimental was upgraded to incorporate Proton 11 changes in April 2026, and stable Proton 10 includes wine-10.0, DXVK-NVAPI 0.9.0, VKD3D-Proton 2.14.1, and wine-mono 9.4.0.
15. Steam Frame is Valve's standalone VR headset announced November 12, 2025 with Snapdragon 8 Gen 3, 16 GB LPDDR5X, 2160x2160-per-eye LCD pancake at 72/80/90/120/144 Hz; release and pricing were delayed in February 2026 due to global RAM shortages.
16. Steam Machine 2 is Valve's living-room PC announced alongside Steam Frame, with semi-custom AMD Zen 4 (6c @4.8GHz), semi-custom RDNA3, 16 GB DDR5 + 8 GB GDDR6, and 512GB or 2TB SSDs; same 2026 RAM-shortage delay.
17. At GDC 2026 Valve announced separate Steam Frame Verified and Steam Machine Verified programs, with Machine Verified dropping Deck-specific UI legibility requirements since Machines target large displays.
18. Steam Workshop supports paid mods on opt-in titles, with creators getting roughly 25% and the game-owner+Valve splitting the rest; buyers get a 24-hour refund window.
19. Steam Families launched September 2024 (replacing Family Sharing + Family View), letting up to 6 members share a full library with parental controls and a child-purchase request flow, and locking a slot for 1 year if a member is removed.
20. Steam's GameNetworkingSockets library is open source and used off-Steam by Epic Online Services and others; cross-play with non-Steam clients is typically wired via EOS, PlayFab, or AccelByte plus your own server.
21. Steam Cloud sync is configured per-app via UFS root paths; Steam Input abstracts 60+ controllers via .vdf action manifests with a glyph API for displaying the active input's button art.
22. Common Steam pitfalls: choosing the wrong app type (Game vs Application vs DLC vs Demo), incomplete Steamworks integration, regional price-gouging triggering parity flags, and pushing a broken build to default with no rollback build pinned.
23. VAC (Valve Anti-Cheat) integration is optional but expected for competitive multiplayer; bans are permanent and platform-wide for that AppID.
24. Steam Demos use their own free AppID gated to a base game, while DLC each get their own AppID and depot, gated in code via ISteamApps.BIsDlcInstalled.
25. The Steamworks Web API exposes server-side REST endpoints under api.steampowered.com (e.g. ISteamUserStats/GetPlayerAchievements, IPlayerService/GetOwnedGames) for stats, achievements, and ownership checks.
26. CI for Steam uploads typically uses GameCI (game-ci/steam-deploy), the CM2Walki/steampipe Docker image, or a dedicated builder Steam account with cached Steam Guard credentials.
27. Indies often dual-publish to itch.io using Butler (butler push <dir> <user>/<game>:<channel>), which has the same delta-chunk patching model as SteamPipe but is free.
