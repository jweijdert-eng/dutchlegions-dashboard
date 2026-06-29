<?php
// Proxy + parser voor de officiële EVE Online nieuws-/patch-notes-feed
// (https://www.eveonline.com/rss). De feed stuurt geen CORS-headers, dus we halen
// 'm server-side op, parsen de items naar schone JSON en cachen 't kort (15 min),
// met terugval op (verlopen) cache als CCP even onbereikbaar is. Geen login nodig.
require_once 'config.php';
cors();
header('Cache-Control: no-cache');

$FEED  = 'https://www.eveonline.com/rss';
$cache = sys_get_temp_dir() . '/eve_news_feed.json';

// Verse cache → meteen terug.
if (is_file($cache) && filesize($cache) > 2 && (time() - filemtime($cache)) < 900) {
    echo file_get_contents($cache);
    exit;
}

function feedFetch(string $url): ?string {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_HTTPHEADER     => [
            'Accept: application/rss+xml, application/xml',
            'User-Agent: DutchLegionsDashboard/1.0 (j.weijdert@gmail.com)',
        ],
    ]);
    $r = curl_exec($ch);
    $c = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ($c === 200 && $r !== false && $r !== '') ? $r : null;
}

// Korte platte-tekst-samenvatting uit de (HTML-)description.
function summarize(string $html, int $len = 280): string {
    $txt = html_entity_decode($html, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $txt = strip_tags($txt);
    $txt = preg_replace('/\s+/u', ' ', trim($txt));
    if (mb_strlen($txt) > $len) $txt = mb_substr($txt, 0, $len - 1) . '…';
    return $txt;
}

$raw = feedFetch($FEED);

// CCP onbereikbaar: val terug op verlopen cache.
if ($raw === null) {
    if (is_file($cache) && filesize($cache) > 2) { echo file_get_contents($cache); exit; }
    http_response_code(502);
    echo json_encode(['error' => 'feed onbereikbaar', 'items' => []]);
    exit;
}

// BOM weg + parsen.
$raw = preg_replace('/^\xEF\xBB\xBF/', '', $raw);
$prev = libxml_use_internal_errors(true);
$xml  = simplexml_load_string($raw);
libxml_use_internal_errors($prev);

if ($xml === false || !isset($xml->channel)) {
    if (is_file($cache) && filesize($cache) > 2) { echo file_get_contents($cache); exit; }
    http_response_code(502);
    echo json_encode(['error' => 'feed onleesbaar', 'items' => []]);
    exit;
}

$items = [];
foreach ($xml->channel->item as $it) {
    $cats = [];
    foreach ($it->category as $c) {
        $c = trim((string)$c);
        if ($c !== '' && !in_array($c, $cats, true)) $cats[] = $c;
    }
    $pub = trim((string)$it->pubDate);
    $ts  = $pub ? strtotime($pub) : false;
    $items[] = [
        'title'      => html_entity_decode(trim((string)$it->title), ENT_QUOTES | ENT_HTML5, 'UTF-8'),
        'link'       => trim((string)$it->link),
        'date'       => $ts ? date('c', $ts) : null,
        'categories' => $cats,
        'author'     => trim((string)$it->author),
        'summary'    => summarize((string)$it->description),
    ];
}

$out = json_encode([
    'items'     => $items,
    'updatedAt' => date('c'),
    'source'    => $FEED,
]);
@file_put_contents($cache, $out);
echo $out;
