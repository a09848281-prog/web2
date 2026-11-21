# v2.0 Preview 検証チェックリスト

## ソース / CI
- [ ] Web JavaScript構文
- [ ] GAS構文
- [ ] motion-core / audio-utils構文
- [ ] Node unit tests
- [ ] HTML ID重複なし / JavaScript参照漏れなし
- [ ] 旧v4.1スタイルのヘッダー・折りたたみ設定・LIVE VIEWツールバー
- [ ] PTTイベント登録が1箇所
- [ ] 表示モード切替が1箇所
- [ ] Previewアプリ版とGAS API互換版の分離
- [ ] Gradle debug APK
- [ ] APK versionCode 420 / versionName 2.0.0-preview / permissions

## Galaxy A22 5G / Android 13
- [ ] APK起動・権限許可
- [ ] 8桁ペアリングコード発行 / 再発行
- [ ] Foreground Service待機・停止
- [ ] 画面消灯中の待機
- [ ] 背面・前面・端末が公開するレンズ切替
- [ ] 画質 / FPS / 画角 / ライト
- [ ] Ambient / Balanced / Voice集音
- [ ] マイク設定を変更して既存接続が不意に切れない
- [ ] 電池・温度・ネットワーク状態

## iPad Safari / PC
- [ ] 画面がv4.1と同じ配置・操作感
- [ ] PTT短押し / 長押し / Pointer Capture中の指移動
- [ ] PTTロックON/OFF / 3分自動停止 / Space / Enter
- [ ] バックグラウンド時PTT停止
- [ ] 音声ミュート / 受信0〜200% / Androidスピーカー0〜100%
- [ ] 全画面ON/OFF後の映像継続
- [ ] 全体表示 / 画面に合わせる
- [ ] Wake Lock
- [ ] 地図、位置追尾、座標コピー、履歴削除
- [ ] 動体検知と通知、CSV
- [ ] 端末詳細・ネットワーク診断・通信量
- [ ] 接続予約・ブックマークレット

## ネットワーク / 長時間
- [ ] 同一Wi-Fi
- [ ] Androidモバイル回線 + iPad Wi-Fi
- [ ] 両端末モバイル回線
- [ ] 一時通信断から再接続
- [ ] 30分以上の接続・待機
- [ ] 熱・電池消費
- [ ] TURN必要環境でのTURN設定確認

## プライバシー
- [ ] 録画機能なし
- [ ] 録音保存なし
- [ ] 静止画保存なし
- [ ] 動体検知履歴はメタデータだけ
