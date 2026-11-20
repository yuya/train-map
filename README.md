# いまどこ路線図（train-map）

地図帳のような情報量の地図（国土地理院タイル）の上に、鉄道の路線図と駅名を重ねて表示する Web アプリです。電車に乗っているときに「いま地図のどこにいるか」「次の駅まであと何分か」がひと目でわかるようにしています。

## 主な機能

- **近くの路線と駅名を表示**：現在地の近くを通る路線を路線色で描き、駅名をラベルで重ねます。ラベルは重ならないように自動で間引きます。
- **遠くの路線**：最初は表示しません。「遠くの路線」をオンにすると、表示中の範囲の路線も読み込みます。
- **乗っている路線の候補**：線路からの近さと進む向きから「○○線・△△方面・次は□□」を候補として出します。各停・急行などの種別も分けて表示します。
- **乗車中の表示**：
  - 上のカードに「次は ○○ あと N 分（HH:MM 着見込み）」を出します。
  - 下にはドア上の案内表示のような駅リストを出し、各駅の到着見込み時刻と現在の位置を示します。
  - 地図では通過した区間が灰色になり、次の駅が強調されます。
- **地図とリストの連動**：リストの駅をタップすると地図がその駅へ移動します。地図の駅をタップすると、リストの同じ駅が強調されます。「ここにいる」で位置を補正できます。
- **GPS が届かないとき**：地下などでは駅間距離からの推定で進みます。駅をタップして「この駅から乗る」で路線を選ぶこともできます。
- **デモ走行**：GPS がなくても、等速・5倍速・20倍速で動きを試せます。

## 使い方

位置情報は https（または localhost）で開いたときしか使えません。

- **GitHub Pages**：Settings → Pages の Source を **GitHub Actions** にします。`main` へのプッシュで `.github/workflows/pages.yml` が動き、路線データの生成と公開をまとめて行います。
- **ローカル**：osmium-tool を入れて `scripts/extract-rail.sh japan-latest.osm.pbf rail.opl` → `node scripts/build-data.mjs --opl rail.opl --out data` で `data/` を作り（小さく試すなら `npm run build-data -- --prefs 13` で東京都だけを Overpass から）、`npm run serve` で http://localhost:8000 を開きます。`data/` が無いときは Overpass API から直接取得する遅いモードで動きます。設定の「地図をタップして指定」と「デモ走行」でも動作を確認できます。

## しくみ（読み込みを軽くする工夫）

- **路線データは事前に生成**：GitHub Actions 上で、[Geofabrik](https://download.geofabrik.de/asia/japan.html) の日本全体の OSM ファイルから鉄道の系統（route リレーション）だけを抜き出し（`scripts/extract-rail.sh`、osmium-tool を使用）、`scripts/build-data.mjs` で静的ファイルに変換します。
  - 月1回作り直し、それ以外のデプロイではキャッシュを使い回します。
  - 生成に失敗したときは、前回のデータのまま公開を続けます。
  - 手動で作り直すときは、Actions の「Run workflow」で `rebuild` にチェックを入れます。
- **ファイルの分け方**：
  - `data/t/{x}_{y}.json`：約5km四方の格子ごとに、通る路線と駅の一覧。
  - `data/r/{id}.json`：系統ごとの停車駅。
  - `data/s/{hash}.json`：線形。同じ線形は共有し、間引いて差分で符号化しています。
- **端末への保存**：`sw.js`（Service Worker）が、一度見た地域の路線データ・地図タイル・ライブラリ・フォントを保存します。次回からは通信なしで表示でき、地下や圏外でも地図が出ます。路線データの版が変わったときだけ取り直します。

## データと注意

- **地図**：[地理院タイル](https://maps.gsi.go.jp/development/ichiran.html)（標準／淡色／写真）。
- **路線・駅**：[© OpenStreetMap contributors](https://www.openstreetmap.org/copyright)（ODbL）。路線データの抜けや乱れは OpenStreetMap の登録内容によります。
- **到着時刻**：駅間距離・種別・GPS の速度から推定しています。公式の時刻表や運行情報ではなく、遅延も反映しません。

## フォント

[yuya/ar-clock](https://github.com/yuya/ar-clock) と同じフォント変数とウェイトを使っています（Inter / Urbanist / Archivo ＋ LINE Seed JP、IBM Plex Sans JP に切り替え可）。
