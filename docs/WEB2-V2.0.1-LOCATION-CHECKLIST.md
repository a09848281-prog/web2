# v2.0.1 Preview 位置情報・RTC検証チェックリスト

## 自動検査 / CI
- [ ] JS / GAS / Kotlin構文
- [ ] location-utils.js構文
- [ ] 位置情報ユニットテスト6件
- [ ] HTML ID重複・JavaScript参照漏れなし
- [ ] Android versionCode 421 / versionName 2.0.1-preview
- [ ] PWA / config / cache version consistency
- [ ] Gradle debug APK build

## 接続中のRTC位置情報
- [ ] Android位置情報権限を許可
- [ ] Webから現在位置を1回取得
- [ ] 位置情報がRTC DataChannelでWebへ届く
- [ ] 地図上のマーカーが更新される
- [ ] 精度・取得時刻・RTCライブ表示が更新される
- [ ] 2台以上のWeb操作端末で同じ位置更新を受ける
- [ ] GAS保存を一時失敗させてもRTCライブ更新は届く
- [ ] RTC接続中に30秒GASポーリングを行わない

## 定期位置情報
- [ ] 接続中の定期取得ON/OFF
- [ ] 接続中10 / 30 / 60 / 300秒
- [ ] 待機中の定期取得ON/OFF
- [ ] 待機中10 / 30 / 60 / 300秒
- [ ] 設定変更がDataChannelでAndroidに即時反映
- [ ] Androidアプリ再起動後も設定を保持
- [ ] 待機中はRTCなしでGAS履歴に保存
- [ ] RTC切断後はGAS履歴のWebポーリングへフォールバック

## iPad / Android実機
- [ ] Galaxy A22 5G / Android 13
- [ ] iPad Safari / PWA
- [ ] Wi-Fi同士
- [ ] Androidモバイル回線 + iPad Wi-Fi
- [ ] 画面消灯・Doze・省電力中
- [ ] 権限拒否・位置情報OFF時の表示
- [ ] GPS取得が遅い／位置精度が悪いケース
- [ ] 30分以上の定期追跡
