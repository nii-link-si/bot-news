/**
 * ITニュース要約＆Mattermost投稿BOT (GAS版)
 * スプレッドシートのB列(2列目)に記載されたRSS URL一覧から記事を取得し、
 * Gemini APIで要約してMattermostに投稿します。
 */

// --- 設定 ---
// スクリプトプロパティから取得するキー名
const PROP_GEMINI_API_KEY = 'GEMINI_API_KEY';
const PROP_MATTERMOST_WEBHOOK_URL = 'MATTERMOST_WEBHOOK_URL';

// 取得対象とする記事の公開時刻（何時間前までの記事を取得するか）
const FETCH_HOURS_AGO = 24; 

// 取得する記事の上限（プロンプト長くなりすぎ防止）
const MAX_ARTICLES = 15;


/**
 * メイン実行関数 (トリガーに設定して定期実行する)
 */
function main() {
  Logger.log('処理を開始します...');
  
  // 1. スプレッドシートからRSSのURLリストを取得
  const rssUrls = getNewsSourcesFromSheet();
  if (rssUrls.length === 0) {
    Logger.log('スプレッドシートにRSSのURLが登録されていません。処理を終了します。');
    return;
  }
  
  // 2. RSSURLから最新のニュース記事を取得
  const articles = fetchNewsFromRssUrls(rssUrls);
  if (articles.length === 0) {
    Logger.log('新しい記事は見つかりませんでした。処理を終了します。');
    return;
  }
  
  // 3. 取得した記事群をGemini APIに投げて要約を生成
  const summaryText = summarizeNewsWithGemini(articles);
  if (!summaryText) {
    Logger.log('要約の生成に失敗しました。処理を終了します。');
    return;
  }
  
  // 4. 要約をMattermostへPOST
  postToMattermost(summaryText);
  
  Logger.log('処理が完了しました。');
}


/**
 * 1. 現在アクティブなスプレッドシートからRSS URL (B列) を取得する
 * @return {string[]} RSS URLの配列
 */
function getNewsSourcesFromSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  // B列(2列目)の2行目から最終行までのデータを取得（1行目はヘッダ想定）
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  
  // getRange(row, column, numRows) -> B列のデータを一括取得
  const range = sheet.getRange(2, 2, lastRow - 1);
  const values = range.getValues();
  
  const urls = [];
  for (let i = 0; i < values.length; i++) {
    const url = values[i][0];
    // 空白セルや http から始まらないものはスキップ
    if (url && typeof url === 'string' && url.startsWith('http')) {
      urls.push(url.trim());
    }
  }
  
  Logger.log(`${urls.length} 件のRSS URLを取得しました。`);
  return urls;
}


/**
 * 2. 複数のRSS URLから記事タイトルとURLを取得する
 * @param {string[]} urls RSSのURL配列
 * @return {Object[]} 記事オブジェクト {title, link, date} の配列
 */
function fetchNewsFromRssUrls(urls) {
  let allArticles = [];
  const timeLimit = new Date(Date.now() - (FETCH_HOURS_AGO * 60 * 60 * 1000));
  
  for (const url of urls) {
    try {
      Logger.log(`RSS取得中: ${url}`);
      const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (response.getResponseCode() !== 200) {
         Logger.log(`[Warning] HTTP Error ${response.getResponseCode()} for: ${url}`);
         continue;
      }
      
      const xml = response.getContentText();
      const document = XmlService.parse(xml);
      const root = document.getRootElement();
      
      // RSS 2.0 or Atom の違いを吸収して簡易的にアイテムを取得
      let entries = [];
      const channel = root.getChild('channel'); // RSS 2.0
      const atomNs = XmlService.getNamespace('http://www.w3.org/2005/Atom'); // Atom
      
      if (channel) {
        entries = channel.getChildren('item');
      } else if (root.getName() === 'feed') {
        entries = root.getChildren('entry', atomNs);
      }
      
      for (const entry of entries) {
        let title = '';
        let link = '';
        let pubDateStr = '';
        
        if (channel) {
          // RSS 2.0
          const tNode = entry.getChild('title');
          const lNode = entry.getChild('link');
          const dNode = entry.getChild('pubDate') || entry.getChild('date', XmlService.getNamespace('http://purl.org/dc/elements/1.1/'));
          title = tNode ? tNode.getText() : '';
          link = lNode ? lNode.getText() : '';
          pubDateStr = dNode ? dNode.getText() : '';
        } else {
          // Atom
          const tNode = entry.getChild('title', atomNs);
          const lNode = entry.getChild('link', atomNs);
          const dNode = entry.getChild('published', atomNs) || entry.getChild('updated', atomNs);
          title = tNode ? tNode.getText() : '';
          link = lNode ? lNode.getAttribute('href').getValue() : '';
          pubDateStr = dNode ? dNode.getText() : '';
        }
        
        // 公開日時を判定して、FETCH_HOURS_AGO 以内のものだけ抽出
        if (title && link) {
          const pubDate = new Date(pubDateStr);
          // 日付がパースできない(Invalid Date)、または timeLimit より最近のもの
          if (isNaN(pubDate.getTime()) || pubDate > timeLimit) {
             allArticles.push({
               title: title.trim(),
               link: link.trim(),
               date: pubDateStr
             });
          }
        }
      }
    } catch (e) {
      Logger.log(`[Error] 取得・パース失敗: ${url} - ${e.message}`);
    }
  }
  
  // 上限件数で絞る（Gemini APIのトークン制限や品質維持のため）
  if (allArticles.length > MAX_ARTICLES) {
    // 軽くシャッフルするか先頭をとるか。ここではシンプルに先頭〜MAX件
    allArticles = allArticles.slice(0, MAX_ARTICLES);
  }
  
  Logger.log(`対象となる新しい記事を ${allArticles.length} 件取得しました。`);
  return allArticles;
}


/**
 * 3. 記事群をGemini APIに送信し、要約を生成する
 * @param {Object[]} articles 記事オブジェクトの配列
 * @return {string} 生成されたMarkdownフォーマットの要約テキスト。失敗時はnull
 */
function summarizeNewsWithGemini(articles) {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty(PROP_GEMINI_API_KEY);
  
  if (!apiKey) {
    Logger.log('[Error] スクリプトプロパティに GEMINI_API_KEY が設定されていません。');
    return null;
  }
  
  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  
  // プロンプト生成
  // 記事リストをテキスト化
  const articlesText = articles.map((a, i) => `[${i+1}] タイトル: ${a.title}\nURL: ${a.link}`).join('\n\n');
  
  const prompt = `
あなたは優秀なIT・テクノロジー系ニュースのキュレーターです。
以下のニュース記事リストを内容ごとに「カテゴリ（ジャンル）」に分類し、ITエンジニア向けに「今日の主要ニュースまとめ」を作成してください。

【出力要件】
- Mattermostに投稿するため、Markdown形式で出力すること
- 冒頭に「# 📰 今日のIT・テックニュースまとめ (` + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy/MM/dd') + `)」という大見出し（H1）をつけること
- 記事の内容を分析し、2〜4つ程度のカテゴリ（例: \`## 🤖 AI・機械学習\`, \`## 🛡️ セキュリティ\`, \`## 💻 開発・インフラ\`, \`## 📱 ガジェット・その他\` など）に分類して中見出しで括ること
- 各カテゴリの中に属するニュース記事を、以下のフォーマットで出力すること：
  ---
  ### [記事のタイトルを入れる]
  - 📝 **要点1:** (簡潔な内容)
  - 💡 **要点2:** (重要な点やIT視点の補足など)
  - 🔗 [記事を読む](URLを入れる)
  ---
- 古い情報や情報価値の低いものは削り、本当に重要な5〜8件程度を厳選すること
- 「です・ます」調であるが、箇条書き部分は体言止めなどで簡潔にすること
- 前置きや後書き（「以下にまとめます」「いかがでしょうか」など）は一切不要。出力結果がそのまま投稿として使える状態にすること

【ニュース記事リスト】
${articlesText}
`;

  const payload = {
    "contents": [{
      "parts": [{
        "text": prompt
      }]
    }]
  };

  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  try {
    Logger.log('Gemini APIに要約リクエストを送信しています...');
    const response = UrlFetchApp.fetch(apiUrl, options);
    
    if (response.getResponseCode() !== 200) {
      Logger.log(`[Error] Gemini APIエラー: ${response.getContentText()}`);
      return null;
    }
    
    const result = JSON.parse(response.getContentText());
    
    // Gemini 2.5 Flash のレスポンスからテキストを抽出
    if (result.candidates && result.candidates.length > 0 && result.candidates[0].content.parts.length > 0) {
      const summaryText = result.candidates[0].content.parts[0].text;
      return summaryText;
    } else {
      Logger.log('[Error] Gemini APIから期待した形式のレスポンスが得られませんでした。');
      return null;
    }
    
  } catch (e) {
    Logger.log(`[Error] Gemini API呼び出し例外: ${e.message}`);
    return null;
  }
}


/**
 * 4. MattermostのIncoming Webhookにマークダウンテキストを投稿する
 * @param {string} text 投稿するMarkdownメッセージ
 */
function postToMattermost(text) {
  const props = PropertiesService.getScriptProperties();
  const webhookUrl = props.getProperty(PROP_MATTERMOST_WEBHOOK_URL);
  
  if (!webhookUrl) {
    Logger.log('[Error] スクリプトプロパティに MATTERMOST_WEBHOOK_URL が設定されていません。');
    return;
  }
  
  const payload = {
    "text": text,
    // オプション機能（Mattermost設定などで上書き可能ですがここで指定もできます）
    // "username": "News Summary Bot",
    // "icon_url": "https://example.com/bot_icon.png"
  };
  
  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };
  
  try {
    Logger.log('MattermostへWebhookを送信しています...');
    const response = UrlFetchApp.fetch(webhookUrl, options);
    
    if (response.getResponseCode() === 200 || response.getResponseCode() === 201) {
      Logger.log('Mattermostへの投稿が成功しました。');
    } else {
      Logger.log(`[Error] Mattermost投稿失敗 (HTTP ${response.getResponseCode()}): ${response.getContentText()}`);
    }
  } catch (e) {
    Logger.log(`[Error] MattermostWebhook呼び出し例外: ${e.message}`);
  }
}
