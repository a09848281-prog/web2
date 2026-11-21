# v1.1 APKクラッシュ予防・検証方針

## 既知情報と限界
過去の会話ではWebから接続した瞬間にAndroidアプリが落ちる報告があった。しかし今回確認できたGitHubの過去資料には、実機LogcatのFATAL EXCEPTIONやnative tombstoneが残っていない。したがって単一のクラッシュ原因を断定する証拠はない。GitHub ActionsのGradle exit code 1（ビルド失敗）は実行中クラッシュとは別の問題である。

「絶対に落ちない」とは、Androidの端末差・OS制御・WebRTCネイティブ処理があるため保証できない。既知の失敗経路を防御し、実機検証で残る問題を記録する。

## 実装上の防御
1. CAMERA / RECORD_AUDIO権限を確認してから監視処理を始める。位置情報は任意とし、拒否されてもカメラ待機を開始できるようにする。
2. Foreground Service開始直後に通知を出し、startForegroundのSecurityException等は捕捉して安全停止する。
3. Foreground Serviceのlocation typeは位置情報権限がある場合だけ追加する。
4. GAS通信、SDP/ICE、ネットワーク処理はUIスレッドで同期実行しない。
5. 空/不正SDP、PeerConnection生成失敗、DataChannel登録失敗、カメラ形式不対応を個別に捕捉する。
6. 希望カメラ形式が使えない場合はVGA/15fpsへフォールバック。
7. RTC処理失敗でForeground Service全体を巻き込まない。部分生成されたRTC/カメラ/音声資源を解放して待機へ戻す。
8. DataChannelはセッション単位に管理し、OPEN状態の時だけ送信する。
9. PeerConnection、DataChannel、CameraCapturer、SurfaceTextureHelper、Tracks、Sources、Factory、EGLを個別に解放する。
10. dispose/stop/close処理は複数回呼ばれても安全な設計にする。
11. ライブ制御はDataChannelを使用する。最大3台のWeb閲覧を受け付けるため、接続台数が3未満の間だけ追加Offer確認のGAS問い合わせを継続し、3台接続時は追加確認を止める。
12. Android Doze、強制停止、電源OFF、権限取消、OSのwhile-in-use制限を回避しない。
13. Android Foreground ServiceはSTART_STICKYを要求し、初回GAS接続失敗時にバックオフ付きで再試行する。
14. ライブ中のみPARTIAL_WAKE_LOCKを取得し、切断・サービス停止・破棄時に解放する。
15. WebRTCのICE DISCONNECTEDは8秒の猶予後にセッション単位で解放し、古いセッションの遅延コールバックが新しいPeerConnectionを破棄しないよう同一性を確認する。
16. 自動画質の適用値と利用者のAuto指定値を分離して保存し、定期GAS設定同期で低負荷設定が元に戻らないようにする。低バッテリー/高温時は自動画質より保護設定を優先する。

## Galaxy A22実機で必須の試験
- 初回起動・カメラ/マイク権限拒否・後から権限取消
- GAS問い合わせ間隔 1秒・10秒・50秒の入力検証と画面消灯時の実測
- GAS URL未設定・GAS応答タイムアウト・ネットワークオフライン
- 空Offer・不正SDP・ICE失敗・DataChannel作成/受信失敗・通知後の再接続
- カメラを他アプリが占有している状態、複数レンズ端末での広角・標準・望遠切替、背面フラッシュ非搭載時のライト要求
- 接続・切断・再接続を連続50回
- Web操作端末を最大3台ペアリングし、同時視聴・1台だけ解除・3台満員時の追加拒否を確認
- ブックマークレット起動でWeb2を開けること、認証トークンがブックマークレットURLに含まれないこと、カメラが自動起動しないことを確認
- 画面消灯、アプリをバックグラウンドへ移動
- Wi-Fiとモバイル通信の切り替え、機内モード、圏外復帰
- 2つのWebセッションを続けて作成し、古いpollAnswersループが新しいセッションへ回答を適用しないこと
- Androidアプリの初回GAS登録失敗後、ネットワーク回復時に自動再試行すること
- 最後のWebRTCセッション切断でWakeLockが解放されること
- Auto画質時の一時的な低負荷設定がGAS同期で即時リセットされないこと
- MotionEventsに画像・サムネイル・映像データが保存されないこと
- 検知イベントの再送キューが異なるAndroid端末に混ざらないこと
- TURN未設定時のSTUNフォールバックとTURN設定時の資格情報処理を確認
- 低バッテリー、高温、OS省電力モード
- マイク/カメラ権限の拒否・再許可

LogcatのFATAL EXCEPTIONとnative crashを確認する。APKビルド成功は実機安定性の証明ではない。
