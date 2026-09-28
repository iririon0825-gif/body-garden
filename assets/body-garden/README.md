# Body Garden 画像アセット（正本待ち）

オルグレイ側で制作した画像は、このディレクトリに **同じファイル名で配置するだけ** で反映されます
（`js/data.js` の `IMAGE_ASSETS` がパスを参照し、`js/ui.js` の `imageWithFallback()` が
未配置時はCSSグラデーションのplaceholderに自動フォールバックします）。

画像内に体重・BMI等の動的な数値やテキストを焼き込まないでください（HTML/CSS側で表示します）。

## 必要なファイル一覧

| ファイル名 | 用途 | 状態 |
|---|---|---|
| hero-morning.webp | HOME上部ヒーロー（通常時） | ✅配置済み |
| hero-maintenance.webp | HOME上部ヒーロー（維持モード時） | 未配置（fallback表示） |
| brand-symbol.png | ブランドシンボル | ✅配置済み |
| icon-weight.png | 体重グラフ／体重記録セクションアイコン | ✅配置済み |
| icon-protein.png | TODAY'S PROTEINカードアイコン | ✅配置済み（再制作版） |
| icon-injection.png | 注射セクションアイコン | ✅配置済み |
| icon-condition.png | 体調セクションアイコン | ✅配置済み |
| icon-composition.png | 体組成タブアイコン | ✅配置済み（再制作版） |
| icon-record.png | 「記録」ナビ／記録一覧アイコン | ✅配置済み |
| icon-settings.png | 「設定」ナビアイコン | ✅配置済み |
| icon-goal1.png | Goal 1関連カードアイコン | ✅配置済み（再制作版） |
| icon-goal2.png | Goal 2関連カードアイコン | ✅配置済み（再制作版） |
| icon-maintenance.png | 維持準備／維持モード表示アイコン | ✅配置済み（再制作版） |
| icon-lower-line.png | BMI20 / LOWER LINE表示アイコン | ✅配置済み（再制作版） |
| icon-home.png | 「HOME」ナビアイコン | ✅配置済み（再制作版） |
| milestone-goal1.png | Goal1達成演出 | 未配置（fallback表示） |
| milestone-goal2.png | Goal2達成演出 | 未配置（fallback表示） |
| milestone-maintenance.png | 維持モード移行演出 | 未配置（fallback表示） |

全アイコン（brand-symbol / icon-weight / icon-protein / icon-injection / icon-condition /
icon-composition / icon-record / icon-settings / icon-goal1 / icon-goal2 / icon-maintenance /
icon-lower-line / icon-home）がRGBA透過PNG・四隅alpha=0・丸角ガラスタイル形式で揃いました。

## アプリアイコン（PWA）

`../../icons/` に以下を配置：
- icon-192.png（192×192）
- icon-512.png（512×512）
- icon-maskable-512.png（512×512, maskable safe zone対応）
