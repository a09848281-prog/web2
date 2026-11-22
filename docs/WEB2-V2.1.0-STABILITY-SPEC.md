# Remote Camera Web2 v2.1.1 Preview — 統合仕様書

作成日：2026-11-21  
対象ブランチ：`preview/v2.1.1-stability`  
対象端末：Android 13 / Galaxy A22 5G、iPad Safari PWA、PCブラウザー  
構成：GitHub Pages + Android APK + Google Apps Script + Google Sheets + WebRTC / DataChannel

## 1. v2.1.1の目的

v2.0.1の位置情報RTCライブ更新を維持しながら、Android側の待機設定、画質反映、端末の画面OFF時・アプリ切替時の接続維持、Webからのカメラ/マイク制御、ライトと通信量表示を改善する。

`main` および旧リポジトリ `web` は変更しない。v2.1.1の変更は専用プレビュー・ブランチに分離する。

## 2. 実装内容

### Android APK
- GAS確認間隔を入力中にSharedPreferencesへ保存し、アプリ再表示・終了後も設定値を復元する。
- 待機中の撮影解像度（360p / 480p / 720p / 1080p）とFPS（10 / 15 / 20 / 24 / 30 / 60）を変更・保存できる。
- 標準の撮影比率は16:9。カメラが対応する撮影形式を優先し、非対応の場合は同じ比率の低い解像度/FPSへフォールバックする。
- WebRTC接続中の撮影設定変更はDataChannel経由で即時反映を試み、実際に採用された解像度/FPSをテレメトリーでWebへ通知する。
- 画面ロック・アプリ切替時はForeground Serviceを維持し、RTCが開いている間はCPU WakeLockとWi-Fi Lockを保持する。
- Androidの待機開始・終了時刻を選択してAlarmManagerへ登録し、予約解除も可能にする。
- 端末内通信量をTrafficStats UIDカウンターから約30秒ごとに集計し、7日・30日の送受信合計を保存する。
- 選択中カメラにフラッシュがある場合は同じカメラIDを優先し、なければフラッシュ対応の背面カメラを探す。失敗時は理由を返す。

### Web / PWA
- わかりにくかった通信量モードの選択UIを廃止し、解像度とFPSを直接指定する。自動調整は画質の「自動」を選んだ場合のみ従来の品質段階で動作する。
- マイク設定はノイズ抑制のみ表示する。感度・ゲイン・集音モードの旧データ項目は互換性のため内部に保持するが、通常UIからは隠す。
- Androidスピーカー音量は引き続き変更できる。
- Android音声の再生ON/OFFボタンは通常UIから外し、接続中のAndroidカメラON/OFFとAndroidマイクON/OFFをDataChannelで操作できるようにする。
- Androidが通知する実撮影解像度/FPS、カメラ/マイク状態、7日/30日通信量を表示する。
- ライト状態は要求送信だけではON/OFFを確定せず、Androidテレメトリーの実状態で表示する。
- Service Workerのキャッシュキーをv2.1.1へ更新する。

### GAS
- GAS API v1.2.0を維持する。今回の集計・カメラON/OFF・実撮影情報はAndroid側とRTC DataChannelで処理するため、GASの再デプロイは不要。

## 3. 画角・解像度・通信量

- 背面カメラ候補はCamera2の焦点距離情報で短い焦点距離を優先する。端末が超広角レンズを別カメラとして公開していれば、そのレンズが優先候補になる。
- ソフトウェアだけで物理レンズの視野角を超えて広くすることはできない。Android標準カメラアプリが独自のレンズ切替や画像処理を使う場合、RTC映像と完全に同じ画角にはならないことがある。
- 1080p / 60FPSは端末カメラとWebRTCエンコーダーが両方対応した場合のみ実際に有効になる。非対応時は実際の撮影形式を表示する。
- 1080p / 60FPSの映像エンコード目標は最大約6Mbps。連続6Mbps送信を単純換算すると約2.7GB/時（映像の送信方向のみ）であり、実際の通信量は映像内容・回線・再送・音声・TURN中継などで変動する。
- 節約モードのUIは廃止した。通信量を抑える場合は、解像度とFPSを下げる。1080p/60FPSを選びながら節約モードで同じ映像を送る、という組み合わせは提供しない。

## 4. 制約・注意事項

- WakeLock/Wi-Fi Lockは画面OFF時の中断を減らす補助策であり、OS・メーカーの省電力制御、電池最適化、ネットワーク切替、強制停止、権限取消を無効化するものではない。
- iPad Safariは別アプリへ切り替えた際にiOSからWebRTC/ページ処理が一時停止・制限される場合がある。Android側だけの変更でiPad Safariのバックグラウンド制限を解除することはできない。
- AlarmManagerの`setAndAllowWhileIdle`は厳密な時刻実行を保証しない。Doze、省電力、強制停止、端末再起動後の復元制限により開始/終了が遅れる、または実行されない場合がある。アプリの強制停止中は予約実行を保証しない。
- 7日/30日通信量はRemote CameraアプリUIDの通信量であり、Android端末の全アプリ合計ではない。集計はv2.1.1が稼働している間に記録を開始し、過去にさかのぼって復元しない。
- ノイズ抑制のUI値は0=OFF、1〜100=ONの要求値であり、強さを線形に調整する機能ではない。効果は端末・WebRTC音声処理モジュールに依存し、音声処理モジュールの再初期化が必要なため次回RTC接続から反映される。
- ライトは端末カメラの使用状態やOEM制限によって点灯できない場合がある。エラーはWebへ返し、点灯したと誤表示しない。

## 5. 禁止・対象外

- Firebase、課金API、録画、録音ファイル保存、静止画保存は追加しない。
- GASの認証方式・ユーザーデータ構造・APIバージョンは変更しない。
- `main` ブランチと旧リポジトリ `web` は変更しない。


## 6. v2.1.1 bug fixes

- Debounce viewport/fullscreen recovery. Do not dispatch a synthetic resize event from the resize handler, preventing a self-triggering timer loop.
- Do not allow camera-facing or physical-camera switching while the Android camera is OFF. The Web camera selector is disabled until the camera is active.
- Continue low-frequency GAS polling at the three-viewer limit so viewer `bye` signals and controller revocations can still be received. The RTC engine continues to enforce the three-viewer cap.
- Restore the saved Android microphone preset in the Web UI. Device-originated settings are persisted to GAS without sending them back as a new DataChannel settings command.
- Restrict Service Worker cache cleanup and offline fallback lookup to the Remote Camera Web2 preview cache namespace so unrelated pages on the same origin are not cleared.
- Release the RTC camera engine before attempting final torch shutdown.
- Increment Android `versionCode` to 423 and label the build `2.1.1-preview` for an in-place update path.
