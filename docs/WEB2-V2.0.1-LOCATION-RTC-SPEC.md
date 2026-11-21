# Remote Camera Web2 v2.0.1 Preview — RTC位置情報改善仕様
作成日：2026-11-21
ブランチ：`preview/v2.0.1-location-rtc`
基点：`preview/v2.0-stability`
GAS API互換：1.2.0（API変更なし）

## 1. 目的
- Androidから取得した現在地を、RTC DataChannel経由でWebへ直接配信する。
- GASを現在地のライブ中継経路から外し、位置履歴の保存・参照に専念させる。
- 接続中／待機中の定期位置取得設定が、Webからの設定保存時にAndroidサービスへ即時反映されるようにする。
- 位置情報の不正値・古い値・重複を防ぎ、地図表示を安定させる。

## 2. 新しい位置情報の通信経路
### RTC接続中
1. Webから「現在位置を1回取得」を押す。
2. WebはRTC DataChannelで `location_once` 命令をAndroidへ送信する。
3. Android Foreground Serviceが位置情報APIで座標・精度・取得時刻を取得する。
4. Androidは `location_update` メッセージを開いている全Web操作端末へRTC DataChannelで送信する。
5. Webは受信した座標を検証し、地図・最新位置・座標コピーをすぐ更新する。
6. Androidは並行してGASの `add_location` APIへ履歴を書き込む。

### RTC未接続／待機中
- Androidの位置情報取得とGAS履歴保存は従来どおり。
- Webの地図はGAS履歴を参照する。
- Webの地図はRTC DataChannelが開いていない場合だけ、30秒間隔のGAS履歴更新を使用する。

## 3. 位置情報データ
RTCメッセージは座標、精度、取得時刻、取得モードのみ。
- `lat` / `lng`
- `accuracy`
- `timestamp`（Unixミリ秒）
- `mode`（manual / connected / background）
- `type: location_update`

位置更新に認証トークン、deviceSecret、個人情報など不要な情報は含めない。RTC DataChannel自体はペアリング済みPeerConnection内で使用する。

## 4. 定期取得機能
既存UI機能を維持する。
- 接続中の定期取得 ON/OFF
- 接続中の間隔：10 / 15 / 30 / 60 / 120 / 300秒
- 待機中の定期取得 ON/OFF
- 待機中の間隔：10 / 15 / 30 / 60 / 120 / 300秒
- Android内部で許容する設定範囲：10〜3600秒
- Foreground ServiceのlocationLoopは5秒ごとに設定と経過時間を確認する。
- 取得間隔は目安であり、GPS取得・ネットワーク・Doze・省電力・端末メーカー制御によって遅れる場合がある。
- 権限がない場合は取得しない。ユーザーがAndroidで位置情報権限を許可する必要がある。

## 5. 安定性修正
- RTCで届いた最新位置を、GAS履歴読み込み中に古いレスポンスで上書きしない。
- RTC DataChannelが開いている間は、30秒ごとのGAS地図ポーリングを止める。
- RTC DataChannelが閉じている場合はGAS履歴ポーリングへフォールバックする。
- AndroidのDataChannel設定更新時に、connectedLocationEnabled / idleLocationEnabled / connectedInterval / idleIntervalを即時適用し、SharedPreferencesにも保存する。
- 2分以内の古いlastKnownLocationを繰り返し使うことを避け、5秒以内の位置キャッシュだけを再利用する。
- Web側で座標・精度・時刻を検証し、範囲外・欠損・未来時刻の異常値を破棄する。
- 位置履歴は重複を除去して時刻順に保持し、最大500件の表示用履歴に制限する。

## 6. プライバシー
- 位置情報はユーザーがAndroid側で許可した場合だけ取得する。
- 接続中はペアリング済みRTC DataChannelへ位置を送る。
- 位置履歴保存は既存GAS + Sheets構成のまま。
- 位置情報のライブ配信・履歴保存とも、ユーザーが定期取得を有効にしたときだけ定期実行する。
- 録画・録音・静止画保存は実装しない。

## 7. バージョン・配布
- Android versionCode：421
- Android versionName：2.0.1-preview
- PWA appVersion：2.0.1-preview
- GAS API version：1.2.0（変更なし）
- TURN/STUN設定はv2.0から継承。

## 8. 検証
- location-utils.jsの不正座標・時刻・精度・秒/ミリ秒変換テスト
- RTC location_update受信と地図反映
- DataChannel接続中はGASポーリングが停止すること
- DataChannel未接続時にGAS履歴へフォールバックすること
- 接続中・待機中の取得ON/OFFと間隔の保存
- GAS保存が失敗してもRTCライブ表示が維持されること
- Galaxy A22 5G / Android 13、iPad Safariで位置情報権限・画面OFF・省電力状態を実機確認すること

CI成功と実機でのGPS精度・バックグラウンド動作は別に評価する。
