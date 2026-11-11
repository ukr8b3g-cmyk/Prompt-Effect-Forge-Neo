# Prompt Effect Forge Neo

Krea2 BBOX Prompt Effectのプリセット176件と見本画像176枚を、Forge Neoで選んでPositiveへ挿入する独立拡張です。元の英語効果文・Boost・画像を保持しています。日本語／英語の表示に対応します。

## 導入

1. [Releases](https://github.com/ukr8b3g-cmyk/Prompt-Effect-Forge-Neo/releases) からインストール用ZIPをダウンロードします。
2. ZIPを展開し、`prompt-effect-forge-neo` フォルダーをForge Neoの `extensions` に入れます。
3. Forge NeoのUIを再起動します。追加パッケージやモデルの導入は不要です。

## 操作

1. txt2img／img2imgのプロンプト領域にある**Prompt Effect**バーから、通常タブ・サイドパネル・別ブラウザータブを開きます。Background Prompterがある場合、その下へバーを配置します。
2. 画像カードを1つ選び、必要なら写真／アニメのStyle Boostを選びます。同じBoostをもう一度押すと解除できます。
3. 効果プレビューを確認し、**txt2imgへ挿入**または**img2imgへ挿入**を押します。対象Positiveのカーソル位置へ挿入し、選択範囲があれば置き換えます。

カード選択やGenerateの実行だけでは文章を追加しません。挿入ボタンを2回押すと2回挿入します。見本画像はモデルへ送信しません。

### EnableとStyle Boost

- 外側バーの**Enable**は、拡張全体の挿入をON／OFFにします。内側には重複するEnableを置きません。
- **Enable Style Boost（スタイルブーストを有効）**は、写真／アニメの追加文だけをON／OFFにします。OFFでも基本の効果文を挿入できます（拡張全体がONで、効果文が空でない場合）。

2つは独立しています。拡張全体をONにしてもBoostはONになりません。Photo／Animeを押すとそのBoostを選び、同じボタンをもう一度押すと解除します。BoostのチェックをOFFにしても最後の種類を記憶し、再びONにすると戻します。プレビュー・Custom本文・保存済み原文・挿入済み文章は区別して保持します。

## お気に入り・履歴

カード右上の**お気に入り**で登録し、**お気に入り済み**を押すと解除できます。登録・解除だけでは選択中の効果やプロンプトを変更しません。組み込み効果と保存済みカスタムの両方に対応します。カスタムはカテゴリの**カスタム**から選べるほか、**すべてのカテゴリ**にも表示されます。

通常タブ・サイドパネル・別ブラウザータブのすべてで、**すべて → 最近使用 → お気に入り**の順です。Background PrompterのシリーズUIに合わせています。開いたときは**検索欄を空・カテゴリをAll categories・表示をAll**に戻し、全件表示から始めます。通常タブ・パネルの開き直し、別タブの再読み込みも同じです。表示条件は画面ごとに管理し、表示中は検索とカテゴリを各絞り込みに適用します。履歴は効果を選択した順に最新20件を表示し、同じ効果は重複しません。

お気に入りと履歴は同じブラウザープロファイル・オリジン・ベースパスに保存し、通常タブ・サイドパネル・別タブで共有します。再読み込みしても残ります。お気に入りと履歴は端末移動用のCustom JSONには含みません。

## カスタム

**カスタムへコピー**で組み込み効果の原文を編集できます。Boostは本文に混ぜず、プレビューの計算時に追加します。保存は読み込んだプリセットを更新し、別名で保存は新しいプリセットを作ります。削除しても編集中の本文は残ります。同名の自動上書きは行いません。

保存先は同じブラウザープロファイル・オリジン・ベースパスのlocalStorageです。名前80文字、本文12,000文字まで。保存容量やアクセス制限で失敗した場合は画面に表示し、編集内容を保持します。端末・ポート・プロファイルを移る場合はJSONを書き出して取り込んでください。元ComfyUIの`[{"name":"...","text":"..."}]`形式も取り込めます。取り込み前に追加予定・改名・拒否理由を表示します。上限2MiB／500件です。

別タブの挿入先は開いた元のWebUIに固定されます。元のWebUIを再読み込みした場合は**再接続**してください。応答がない場合に自動再送はしません。反映済みの可能性があるため、元のPositiveを確認してから再操作してください。

## 検証

```powershell
python tools/verify_assets.py
node --check javascript/prompt_effect.js
node --test tests/core.test.cjs tests/transport.test.cjs tests/library.test.cjs tests/controls.test.cjs
```

上のコマンドで、カタログと画像の照合、JavaScriptの構文、挿入・同期・カスタム・Enable／Boostの回帰テストを実行できます。

## English

An independent Forge Neo extension containing the original 176 Krea2 Prompt Effect presets and preview images. Select an effect, inspect its preview, and explicitly insert it into the txt2img or img2img Positive prompt. It supports a regular tab, side panel and linked browser tab, exclusive Photo/Anime Boost, browser-stored Custom presets, and JSON import/export. It does not append text on Generate. Disable blocks future insertions and keeps your edits.

The outer Enable controls insertion for the extension. The regular tab, side panel and browser picker contain only Enable Style Boost, which controls the optional Photo/Anime phrase. Turning Boost off leaves the base effect insertable when the extension is enabled. The two states synchronize and persist independently; re-enabling Boost restores its last choice.

Use each card's Favorite/Favorited button to add or remove favorites. All/Recent/Favorites is the order in the regular tab, side panel and browser tab, following the Background Prompter layout. Recent shows the 20 most recently selected effects without duplicates. Favorites and history include saved Custom presets, persist in this browser/origin/base path, and synchronize across tabs. They are separate from Custom JSON exports.

Every view opens with Search empty, All categories selected, and the All filter active. Returning to the regular tab, reopening the side panel, or opening/reloading a browser picker starts with all effects. Each view owns its browsing conditions, so another view's search/category is not reapplied during connection or synchronization.

Download the install ZIP from [Releases](https://github.com/ukr8b3g-cmyk/Prompt-Effect-Forge-Neo/releases), extract its `prompt-effect-forge-neo` folder into Forge Neo's `extensions` directory, and restart the UI. No additional dependencies are required. Custom data belongs to the browser profile, origin and base path; export JSON to move it. Reconnect a picker after reloading the original WebUI. A timed-out insertion is never retried automatically; check the original prompt first.

See [NOTICE](NOTICE.md) for fixed upstream sources and asset provenance.
