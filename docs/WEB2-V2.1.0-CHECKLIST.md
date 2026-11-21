# Remote Camera Web2 v2.1.0 Preview — 検証チェックリスト

作成日：2026-11-21  
対象ブランチ：`preview/v2.1.0-stability`

## CI / ソース検証
- [ ] JavaScript・GAS構文チェック
- [ ] motion / audio / location の単体テスト
- [ ] v2.1.0専用プロジェクト検査
- [ ] Android Gradle debug APKビルド
- [ ] APK artifactをActionsから取得可能
- [ ] APK versionName = 2.1.0-preview / versionCode = 422
- [ ] PWA Service Worker cache key = v2.1.0

## Android実機（Galaxy A22 5G / Android 13）
- [ ] GAS URLが起動直後から正常に読み込まれる
- [ ] GAS確認間隔を1 / 10 / 30 / 50秒に変更し、アプリ終了・再起動後も保持
- [ ] 待機中に撮影画質・FPSを変更し、保存・復元できる
- [ ] Webから720p / 1080p、24 / 30 / 60FPSを選び、表示された撮影形式と実映像を確認
- [ ] 背面広角レンズが優先選択され、Android標準カメラと画角を比較
- [ ] WebからAndroidカメラOFF / ON
- [ ] WebからAndroidマイクOFF / ON
- [ ] Androidスピーカー音量を変更し、端末音量表示と照合
- [ ] ノイズ抑制 OFF / ON と次回接続からの反映
- [ ] ライトON / OFF、エラー時に誤ったON表示にならない
- [ ] 画面ロック中に5分以上接続維持
- [ ] Androidで別アプリへ切替後も接続維持
- [ ] Wi-Fi切替 / Wi-Fiからモバイル回線への切替後に復旧する
- [ ] Web全画面ON / OFFを数回繰り返し映像が復帰
- [ ] 待機開始・終了の予約、予約解除、省電力時の実行を確認
- [ ] 過去7日 / 30日通信量が増分集計される

## iPad / PC
- [ ] GitHub Pagesでv2.1.0画面が配信される
- [ ] Safariの旧キャッシュが更新される
- [ ] Android接続、映像・音声受信、DataChannel操作
- [ ] 全画面ON / OFF後も映像が復帰
- [ ] 接続 / 切断 / 再接続を繰り返してUIが固まらない
- [ ] Androidの撮影形式・カメラ/マイク状態・7日/30日通信量が表示される

## 正式リリース判定
- [ ] CI成功
- [ ] Galaxy A22 5G実機検証完了
- [ ] iPad Safari実機検証完了
- [ ] 未解決エラーなし、または既知制約を記録
- [ ] すべて確認後に正式リリースを判断

注意：CI成功はソース検査・単体テスト・ビルドの成功を示すもので、Android/iPad実機の動作安定性を保証しない。
