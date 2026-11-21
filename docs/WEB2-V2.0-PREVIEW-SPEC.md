# Remote Camera Web2 v2.0 Preview 仕様書
作成日：2026-11-21
対象ブランチ：`preview/v2.0-stability`
基準：旧web v3.8 / v3.9 / v4.0 / v4.1 + Web2 v1.2
対象：Android 13 / iPad Safari PWA / PC browser
位置付け：プレビュー・実機検証前。v1.2 mainは保持し、旧webも変更しない。

## 1. 開発方針
- 旧webの画面デザインを再採用する。濃紺ヘッダー、左側の折りたたみ設定、右側の大型LIVE VIEW、映像上部の操作ツールバー。
- Web2 v1.2で実装済みの機能を維持し、旧版の機能・操作性を統合する。
- Android APK / PWA / GAS + Sheets / WebRTC + DataChannel構成を維持。Firebase、外部AI API、VPSは使わない。
- v2.0 Previewは独立ブランチ。mainと旧webは変更しない。
- 録画・録音・静止画保存は実装しない（旧版にあったスナップショット機能も復活させない）。

## 2. 旧webから引き継ぐ機能
### v3.8 安定性
- WebRTC接続監視、映像フリーズ検知、初回フレーム未着信監視
- ICE / DataChannel状態確認と自動再接続
- 全画面・iOS Safari復帰時に既存MediaStreamの再生を復元
- WebRTC統計・接続状態・通信品質の表示
- Web Audio受信ゲイン制御

### v3.9 カメラ・通信設定
- 360p / 480p / 720p / 1080p
- 10 / 15 / 20 / 24 / 30 / 60 FPS（端末対応範囲）
- 16:9 / 4:3 / 1:1 / 9:16 / 元比率
- 通信量モード：自動 / 超節約 / 節約 / 標準 / 高画質
- 背面 / 前面、端末が公開するカメラレンズの選択
- ライトON/OFF、Web側ズーム、全体表示/画面に合わせる
- 画面スリープ防止（対応ブラウザーのみ）
- 自動画質調整、電池・温度・カメラ状態の表示

### v4.0 / v4.1 音声
- Androidマイク集音：環境音重視 / バランス / 声重視
- Web受信音量0〜200%、Android PTT受信スピーカー音量0〜100%
- 音声レベルメーター、Android受信音声ミュート
- 大型PTT、送話ロック、3分安全タイマー、Space/Enterキー
- PTT中の半二重制御、画面バックグラウンド時の送話自動停止
- マイクモードは既存RTC Engineを破棄せず、次回新規セッション開始時に反映

## 3. v1.2から維持する機能
- 8桁・10分・一回限りのペアリング、ログイン不要
- 最大3台のWeb操作端末、個別controllerToken
- WebRTCメディアと接続後DataChannel操作
- 位置情報の一回取得・定期取得、地図、履歴、履歴削除、座標コピー、最新位置追尾
- Androidネットワーク診断、通信量、送受信速度、RTT、損失率、GAS応答時間
- 詳細端末情報（機種、Android、バッテリー、温度、熱状態、カメラ、ライト、ネットワーク）
- 接続予約、ブックマークレット、動体検知、履歴、CSV、任意通知
- CSV式インジェクション対策、API URL検証、GAS API互換性確認
- 録画・録音・静止画保存なし

## 4. UI構成
- 上部：濃紺ヘッダー、製品名、接続状態、接続時間。
- 左パネル：端末ペアリングと選択、折りたたみ式の「映像・通信」「音声・PTT」「位置情報」「スマート監視」「接続予約」「診断・その他」。
- 右パネル：LIVE VIEW、接続/切断、映像/地図タブ、PTT/ロック、音声ミュート、全画面、表示モード、ライト、Wake Lock、端末情報。
- ライブ映像下：Android通信量、WebRTC統計、端末状態、診断詳細。
- PC/iPadでは2カラム、スマートフォン幅では映像を上、設定を下に並べる。
- v1.2で追加した計測カードや端末詳細も旧UIと視覚的に統一する。

## 5. 安定性修正
- PTT pointer capture中にpointerleaveだけで送話を停止しない。pointerup / pointercancel / lostpointercaptureで解除。
- 表示モード切替イベントは1回だけ登録（二重登録バグを修正）。
- ページ表示状態の監視は単一のvisibilitychangeハンドラーに統合。
- バックグラウンドへ移動したときPTTロックも解除してマイク送信を停止。Wake Lockを解放。
- API互換性バージョンとPWA表示バージョンを分離。PreviewラベルだけでGAS API非互換警告を出さない。

## 6. バージョン・API
- PWA / Android versionName：2.0.0-preview
- Android versionCode：420
- GAS API互換性：1.2.0（API契約変更なし。既存GAS v1.2を利用）
- GAS URLはconfig.jsonの`GAS_EXEC_URL_HERE`を、デプロイ済みWebアプリの正しい`/exec` URLに置換する必要がある。
- TURNは任意設定。GASはTURN中継サーバーではない。

## 7. 完成判定
1. Node.jsでWeb / motion / audio / GAS構文検査。
2. 既存ユニットテストをすべて実行。
3. HTML ID重複とJS参照漏れ検査。
4. PTT・全画面・地図・映像表示イベントの重複登録を検査。
5. Android Kotlin / Gradle debug APKビルド。
6. APKの権限、package、versionCode、versionNameを検査。
7. Galaxy A22 5G / Android 13で待機、接続、ライト、カメラ切替、通信断、自動復帰。
8. iPad Safariで音声受信、受信音量、PTT、ロック、安全タイマー、全画面復帰を確認。
9. Wi-Fi / モバイル回線を跨ぐ実機接続を確認。STUNのみで接続できない環境ではTURNを設定。
10. 録画・録音・静止画保存機能が存在しないことを検査。

CI成功と実機合格は別に記録する。クラッシュゼロやバックグラウンド動作を実機確認なしに保証しない。
