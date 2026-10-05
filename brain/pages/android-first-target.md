---
id: android-first-target
title: "Android 先行驗證"
category: decision
status: active
tags: [iOS 延後但程式碼保持跨平台]
created: "2026-10-04T13:39:43"
updated: "2026-10-05T08:04:51"
---

<!-- compiled_truth -->
# Android 先行驗證

## 決定
第一階段只把 **Android** 視為可驗證的目標平台。iOS 側不寫任何平台專屬程式碼，但整個 codebase 不得引入阻礙 iOS 的依賴或抽象。

## 為什麼
開發機是 Linux，裝了 Android SDK (`$ANDROID_HOME=/home/gem/android-sdk`)，但**沒有 Xcode**。這代表 iOS 只能靠型別檢查與文件保證，無法實際 build 與真機驗證。把 iOS 當一等目標會讓「能不能跑」變成猜謎。

## 約束
- 可以做的事：`npx expo run:android` 出 APK、啟 emulator、截圖、看 logcat。這些是主要的驗證手段。
- 不做的事：在 iOS 上「順便」加原生模組或 Objective-C/Swift 程式碼。若某功能在 iOS 需要降級，用 `#ifdef Platform.OS` 或能力檢查處理，不污染核心層。
- 所有 core 邏輯（markdown、merge、git）必須是純 TypeScript，不 import 任何 React Native API，因此永遠可以在 Node 裡測試。

## 後果
- 驗證策略以 Android 為主；iOS 相容性是「設計時不阻礙」，不是「測試時保證」。
- 若未來真的需要 iOS 發布，再補 Xcode 機器與 build 驗證。


## Timeline

- time: 2026-10-04T13:39:43
  kind: decision
  summary: "Created this page: Android 先行驗證"
  source: user-confirmed 2026-10-04
  affects: [android-first-target]

- time: 2026-10-04T13:39:59
  kind: decision
  summary: Rewrote compiled_truth to the new best understanding
  source: user-confirmed 2026-10-04
  affects: [android-first-target]

- time: 2026-10-05T08:04:51
  kind: evidence
  summary: "Shipped v0.1.0-preview.1 as a release asset, but on-device verification is still impossible here (no /dev/kvm); the APK itself has never been installed or run"
  source: gradlew assembleRelease 2026-10-05
  affects: [android-first-target, android-release-signing]
