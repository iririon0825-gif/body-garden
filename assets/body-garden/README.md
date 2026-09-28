# Body Garden 画像アセット（正本待ち）

オルグレイ側で制作した画像は、このディレクトリに **同じファイル名で配置するだけ** で反映されます
（`js/data.js` の `IMAGE_ASSETS` がパスを参照し、`js/ui.js` の `imageWithFallback()` が
未配置時はCSSグラデーションのplaceholderに自動フォールバックします）。

画像内に体重・BMI等の動的な数値やテキストを焼き込まないでください（HTML/CSS側で表示します）。

## 必要なファイル一覧

| ファイル名 | 用途 |
|---|---|
| hero-morning.webp | HOME上部ヒーロー（通常時） |
| hero-maintenance.webp | HOME上部ヒーロー（維持モード時） |
| brand-symbol.png | ブランドシンボル |
| icon-weight.png | 体重セクションアイコン |
| icon-protein.png | タンパク質セクションアイコン |
| icon-injection.png | 注射セクションアイコン |
| icon-condition.png | 体調セクションアイコン |
| icon-composition.png | 体組成セクションアイコン |
| milestone-goal1.png | Goal1達成演出 |
| milestone-goal2.png | Goal2達成演出 |
| milestone-maintenance.png | 維持モード移行演出 |

## アプリアイコン（PWA）

`../../icons/` に以下を配置：
- icon-192.png（192×192）
- icon-512.png（512×512）
- icon-maskable-512.png（512×512, maskable safe zone対応）
