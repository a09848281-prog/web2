# Remote Camera Web2 仕様書 v4.0.0
作成日：2026-11-20 / 対象：Galaxy A22 5G・Android 13、iPad PWA、PC Web / 個人利用

## 1. 構成
- Android：KotlinネイティブAPK、Foreground Service、WebRTC
- iPad / PC：GitHub PagesのHTML/CSS/JavaScript PWA
- ペアリング・初期シグナリング：GAS + Google Sheets
- 映像・音声：WebRTC RTP/SRTP
- 接続後の操作・設定・状態・診断：WebRTC DataChannel
- Firebase / FCM / 外部AI API：不使用
- 映像録画・音声録音・静止画保存・メディア履歴：実装しない
- 既存 `a09848281-prog/web` は変更しない

## 2. 接続方式
1. Androidを前面で開き、必要な権限を確認して利用者が待機を開始。
2. 待機中はカメラ・マイクを停止し、APKで指定した秒数の間隔でGASへ接続要求を確認。
3. Androidに8桁・10分有効・一回限りのペアリングコードを表示。
4. Web側でコードを入力し、操作端末をペアリング。
5. WebがOfferとDataChannelを生成し、GASを使って初回SDP/ICEを交換。
6. AndroidがAnswerを返す。
7. DataChannelがOPENになった後は、通常操作・設定・ACK・テレメトリー・ネットワーク診断をDataChannelだけで送受信し、GASポーリングを停止。
8. RTC/DataChannelが切断した場合は、再接続の新しいSDP/ICE交換のためGAS確認を再開。
9. WebRTCのメディアはGASを通さない。ネットワーク条件によってはTURN中継が必要になる。現在の初期設定はSTUN/TURNなしなので、異なるネットワーク間の接続は保証しない。

## 3. Androidバックグラウンド待機
- APKで接続要求確認間隔を秒単位で自由入力。範囲5～3600秒、初期値30秒。
- Foreground Serviceと継続通知を使用。
- 待機中はカメラ・マイクを停止。
- DataChannel接続後はGASポーリングを停止し、チャネルからの直接操作を受ける。
- Doze、省電力モード、メーカー独自制御で指定秒数より遅れる場合がある。
- 強制停止、端末電源OFF、権限取消、圏外では遠隔接続を保証しない。

## 4. 映像・カメラ
- Androidカメラのリアルタイム映像配信
- 背面 / 前面カメラ切り替え
- 端末が対応する範囲で解像度・FPS・ビットレート変更
- 16:9などの表示比率、全画面表示
- 画角は端末が持つ物理カメラとAPIの対応範囲内
- ライト操作は端末・カメラAPI対応範囲で提供
- 切断時は古い映像をライブとして表示し続けない
- 録画・静止画保存なし

## 5. 音声
- AndroidマイクからWebへのリアルタイム音声
- Web PTTからAndroidへのリアルタイム音声
- Androidスピーカー音量0～100
- マイク送信ゲイン0～100
- マイク感度/自動ゲイン要求0～100
- ノイズ抑制要求0～100
- ミュート・PTT
- 録音保存なし

**重要な制限：** Android標準NoiseSuppressorや一般的なWebRTC音声制御は、全端末で連続的な0～100の実効強度を保証しない。現在の実装では値を要求値として保存し、対応するON/OFF型の処理は音声ソース初期化時に反映する。音声ゲインは接続中に調整できる。スライダー数値と実際の抑制量が比例するとは限らない。

## 6. DataChannelの操作
接続後にDataChannelで送る操作：
- カメラ切り替え
- 画質・FPS・ビットレート
- スピーカー音量
- マイクノイズ抑制要求・感度要求・送信ゲイン
- 夜間モード要求
- 位置情報の一回取得
- 診断要求
- 切断要求
- 命令ACK、端末状態、通信量

DataChannelがない接続前の段階だけGASを使う。設定保存などの管理データはGAS/Sheetsへ保存する場合があるが、接続中の即時操作はDataChannelを優先する。

## 7. 追加機能
- 夜間モード要求（実際の露出・暗所制御は端末カメラ対応に依存）
- 端末温度・熱状態監視
- 低バッテリー/高温時の負荷低減
- 接続予約（ブラウザー・Android OSが動作を許可する条件に限定）
- 通信断時の自動復旧
- 複数Android端末の登録・選択
- 通信量・画質モード

## 8. 通信量・ネットワーク診断
- WebRTC DataChannelがOPENになった時点でAndroidアプリUID通信カウンターを基準化。
- Androidから送信量、受信量、合計、速度を2秒ごとにDataChannel送信。
- Android UID統計はアプリ全体の通信を含むことがあり、WebRTCだけの通信量と一致するとは限らない。
- Web側はgetStats()でRTP送受信量、RTT、パケット損失を表示。
- Android側診断：ネットワーク種別、validated状態、metered状態、信号強度（取得可能な場合）、ローカルIP、DNS、インターフェイス、Androidバージョン、端末モデル、RTCチャネル状態。
- エラー時に診断要求を送る。DataChannelが切断している場合は、再接続後に再取得。
- Wi-Fiパスワード、deviceSecret、controllerToken等の認証秘密情報は診断に含めない。
- 取得できない情報は「取得不可」とする。

## 9. 安定性・安全
- 権限拒否、Foreground Service開始失敗、不正SDP、カメラ形式不対応、RTC生成失敗を個別に捕捉。
- カメラ・音声・DataChannel・PeerConnectionの終了処理は多重実行に耐えるようにする。
- 位置情報権限は任意。未許可でも待機を開始できる。
- カメラ・マイク利用はAndroidの通知とプライバシー表示で確認できる。
- Android OSの強制停止や権限制約を回避しない。
- 実機Logcatテストなしにクラッシュゼロを保証しない。

## 10. 完成判定
1. GitHub ActionsでAndroid debug APKをビルド。
2. JS/GAS構文検査とHTML/JS要素検査。
3. Galaxy A22 5G / Android 13で待機開始・画面消灯・設定間隔を検証。
4. ペアリング、初期SDP/ICE、DataChannel確立を確認。
5. DataChannel確立後にGASポーリングが停止することを確認。
6. 映像、双方向音声、PTT、カメラ、音量、マイク設定を確認。
7. 通信量・RTC統計・Androidネットワーク診断を照合。
8. 権限拒否、通信断、連続接続/切断、熱・低バッテリーを実機試験。
9. 録画・録音・静止画の保存機能が存在しないことを確認。

ビルド成功だけで完成扱いにしない。実機試験結果を分けて記録する。
