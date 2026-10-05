---
slug: roadmap
title: Roadmap
role: milestones
updated: "2026-10-05T08:04:51"
---

# Roadmap

---
slug: roadmap
title: Roadmap
role: milestones
updated: "2026-10-05T16:05:00"
---

## Milestones

```mermaid
gantt
  title Roadmap
  dateFormat YYYY-MM-DD
  section 已完成
  core 層 markdown merge git richtext   :done, 2026-06-22, 2026-10-05
  同步鏈路與適配器                      :done, 2026-10-05, 1d
  逐區域衝突解決                        :done, 2026-10-05, 1d
  CI 與第一次預覽發布                    :done, 2026-10-05, 1d
  section 下一步
  取得可啟動的 Android 裝置或主機        :crit, 1d
  編輯器接上真實筆記                    :2d
  IME 與點擊位置驗證                    :crit, 2d
  區塊虛擬化                            :3d
  section 以後
  正式簽名金鑰與 Play 商店              :4d
  iOS 版本                              :5d
```

## 現在卡在哪裡

**唯一真正阻塞的是真機驗證。** 開發主機沒有 `/dev/kvm`，emulator 起不來，
所以下列每一項都還沒有被任何自動化或人工驗證過：

- 編輯器兩層對齊（debug 模式就是為了等人去開著看）
- 中文輸入法組字期間的錯位
- git 適配器對真實 expo-file-system 的行為（邏輯全測過，expo 那側未驗證）
- 已發布的 APK 在真機上能不能裝、能不能跑

見 [[android-first-target]] 與 [[android-release-signing]]。
