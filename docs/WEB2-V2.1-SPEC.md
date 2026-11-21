# Remote Camera Web2 v2.1 — 安定性・遠隔設定改善仕様
作成日：2026-11-21
基点：preview/v2.0.1-location-rtc
対象：Galaxy A22 5G / Android 13、iPad Safari PWA、PCブラウザー
構成：Android Kotlin APK + GitHub Pages PWA + GAS + Google Sheets + WebRTC / DataChannel
GAS API：1.2.0互換を維持（不要なAPI変更を避ける）

## 1. 基本方針
- 旧 web リポジトリと web2 main は変更しない。
- v2.1作業は preview/v2.1-stability-controls のみで行う。
- WebRTC DataChannelを接続中の操作・設定反映の優先経路とし、GASは待機中の命令配送・履歴保存・設定永続化のフォールバックとする。
- 録画、録音、静止画保存は追加しない。
- Androidの強制停止、OSによるプロセス終了、権限取消、電池最適化、機種固有制御を突破する機能は約束しない。

## 2. Androidアプリ設定
- GAS問い合わせ間隔を入力時点でSharedPreferencesへ保存し、アプリを閉じて再起動しても設定値を復元する。
- 待機中に通信量上限（映像ビットレート上限）を変更できるようにする。
- 監視待機の開始時刻・終了時刻を予約できるようにする。予約はAndroid AlarmManagerを使う。Doze/メーカー制御により実行時刻が遅れる可能性をUIで明示する。
- 接続中にWebから変更した設定をDataChannelで即時適用し、Androidから適用結果・実際のキャプチャ解像度/FPSを返す。

## 3. 音声
- Androidマイク設定はノイズ抑制のみ残す。マイクモード、感度、ゲインなど細分化項目はUIから削除する。
- Androidスピーカー音量の遠隔調整は維持し、STREAM_MUSICの実音量を読み戻して適用結果を返す。
- Web側のAndroid音声ON/OFFボタンは削除する。iPad/PC受信音量は残す。

## 4. 映像・画角
- 通信量モード（超節約/節約/標準/高画質）は削除し、画質・FPSとビットレート上限を直接設定する方式にする。
- 1080p/60FPS選択時も、通信量上限に応じて映像エンコードの最大ビットレートのみ制限する。解像度/FPSと通信量上限の役割をUIに説明する。
- Android Camera2の利用可能な背面カメラ情報（焦点距離、センサー領域、対応サイズ）を列挙し、最も広角側を初期選択する。
- 可能な端末では超広角/広角カメラを個別選択できるようにする。物理カメラをOS/WebRTCが公開しない場合はハードウェア制約として表示する。
- 画角の拡大はセンサー/レンズ依存であり、ソフトウェアだけで実際の視野角を拡大できない。表示ズームは1.0xを維持し、デジタルズームで狭めない。
- 設定変更後にAndroidから実適用値を返し、Web側に「要求値 / 実適用値」を表示する。

## 5. Web側の遠隔操作
- 接続中、WebからAndroidカメラ送信ON/OFF、マイク送信ON/OFFをDataChannelで切替可能にする。
- 送信OFFはMediaStreamTrackを無効化し、再ONで復帰する。Android側のカメラ・マイク権限を回避しない。
- ライト制御は現在のカメラIDを基準にし、未対応/カメラ使用中/OS拒否のエラーを捕捉してWebへ返す。成功応答後にだけUI状態を変更する。
- 画面スリープ防止はWeb閲覧端末のScreen Wake Lock機能であり、Androidカメラ端末の画面やForeground Serviceを維持する機能ではないことを明記する。未対応ブラウザーでは無効表示。

## 6. 接続安定性
- AndroidのForeground Serviceを維持し、RTC接続中の部分WakeLockを適切に取得/解放する。
- ActivityのonPause/onStopや画面ロックだけでRTCを破棄しない。
- ICE DISCONNECTEDは短時間で即破棄せず、回復猶予を設ける。FAILED/CLOSEDのみ終了扱いとする。
- Web側もページ非表示だけを理由にPeerConnectionを閉じない。PTT送話だけはバックグラウンド移行時に安全のため停止する。
- DataChannelの状態、設定ACK、再接続理由を診断表示する。

## 7. 通信量
- 接続セッションの送受信量を表示する。
- AndroidアプリUIDのTrafficStatsを継続サンプリングし、日別バケットをSharedPreferencesに保存する。
- 過去7日・30日の累計を表示する。これは本アプリUIDの通信量推定であり、端末全体/他アプリの通信量ではない。OS再起動・サンプリング停止・TrafficStats未対応時の欠測を表示する。
- 待機中に上限を変更できる。上限到達時は解像度/FPSを勝手に変更せず、ビットレートを制限し、通知とWebテレメトリーで知らせる。

## 8. 予約
- APKに毎日の待機開始/終了時刻を設定できるUIを追加する。
- AlarmManagerの実行時刻は省電力設定やOS制御で遅れる可能性がある。
- 終了予約はサービス停止とRTCセッション終了を行う。
- カメラ/マイクは待機中に起動せず、Webから接続された場合のみ使用する。

## 9. 検証・リリース条件
- Kotlin/Gradleビルド成功。
- JavaScript構文・GAS構文チェック成功。
- DataChannel設定変更/ACK、音量、ノイズ抑制、カメラ/マイクON/OFF、ライト失敗時UI復元をテスト。
- GAS問い合わせ秒数がアプリ再起動後も保持されること。
- 7日/30日通信量集計の日付境界・再起動・TrafficStats未対応をテスト。
- AlarmManager予約の開始/終了とキャンセルをテスト。
- ICE一時切断の回復猶予をテスト。
- CI成功とGalaxy A22 5G実機での長時間/画面ロック/他アプリ切替検証は別評価とし、未実機検証項目を明示する。
