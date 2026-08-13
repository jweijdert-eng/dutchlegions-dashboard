<?php
/**
 * Thera/Turnur-wachtpost voor Delve — meldt nieuwe wormhole-verbindingen.
 *
 * Bron: EVE-Scout (publiek, geen token)
 *   GET https://api.eve-scout.com/v2/public/signatures
 *       → alle bekende gaten vanuit Thera én Turnur; per gat de k-space kant
 *         (in_system_*) met sig-id, gattype, max scheepsgrootte en verlooptijd.
 *
 * Wij houden alleen de gaten over die in de bewaakte regio's uitkomen (default
 * Delve) óf binnen X sprongen van het staging-systeem liggen. Elk nieuw gat
 * wordt één keer naar een Discord-webhook gestuurd; de sig-id's staan in de DB
 * zodat er nooit dubbel gemeld wordt.
 *
 * Sprongafstand komt uit de statische bestanden die al op de site staan
 * (system-jumps.json / systems.json) — geen ESI-calls nodig.
 *
 *   GET ?action=list                      → lijst voor het dashboard
 *   GET ?action=poll&key=<sleutel>        → verversen + melden (voor de cron)
 *   GET ?action=config&token=<eve-token>  → instellingen lezen (admin)
 *  POST ?action=config                    → instellingen opslaan (admin)
 *   GET ?action=test&token=<eve-token>    → testbericht naar Discord (admin)
 */

require_once 'config.php';
cors();

const ES_URL          = 'https://api.eve-scout.com/v2/public/signatures';
const ES_TTL          = 120;          // feed maximaal 2 minuten oud
const ES_UA           = 'dutchlegions-dashboard (thera-wachtpost)';
const ES_HOME_DEF     = 30004759;     // 1DQ1-A
const ES_REGIONS_DEF  = [10000060];   // Delve
const ES_JUMPS_DEF    = 6;            // ook melden binnen 6 sprongen van staging
const ES_BFS_MAX      = 15;           // niet verder rekenen dan dit

// Kleuren van de Discord-embed: hoe dichterbij, hoe roder.
const ES_KLEUR_DICHT  = 0xE23C3C;
const ES_KLEUR_REGIO  = 0xE8A33D;
const ES_KLEUR_VER    = 0x3D9BE8;

const ES_MAAT = [
    'small'   => 'fregat (S)',
    'medium'  => 'cruiser (M)',
    'large'   => 'battleship (L)',
    'xlarge'  => 'capital (XL)',
    'unknown' => 'onbekend',
];

// ---------------------------------------------------------------- schema
function theraSchema(PDO $pdo): void {
    $pdo->exec("CREATE TABLE IF NOT EXISTS thera_sigs (
        sig_id      VARCHAR(24) PRIMARY KEY,
        system_id   INT NOT NULL,
        system_name VARCHAR(64) NOT NULL DEFAULT '',
        region_id   INT NOT NULL DEFAULT 0,
        region_name VARCHAR(64) NOT NULL DEFAULT '',
        sec         DECIMAL(4,2) NOT NULL DEFAULT 0,
        jumps       INT NULL,
        out_system  VARCHAR(32) NOT NULL DEFAULT '',
        in_sig      VARCHAR(16) NOT NULL DEFAULT '',
        out_sig     VARCHAR(16) NOT NULL DEFAULT '',
        wh_type     VARCHAR(16) NOT NULL DEFAULT '',
        max_size    VARCHAR(16) NOT NULL DEFAULT '',
        gemeld_door VARCHAR(64) NOT NULL DEFAULT '',
        expires_at  DATETIME NULL,
        first_seen  DATETIME NOT NULL,
        last_seen   DATETIME NOT NULL,
        notified_at DATETIME NULL,
        closed_at   DATETIME NULL,
        INDEX (last_seen), INDEX (closed_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $pdo->exec("CREATE TABLE IF NOT EXISTS settings (
        `key` VARCHAR(64) PRIMARY KEY, value TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
}

// ---------------------------------------------------------------- instellingen
function theraSet(PDO $pdo, array $kv): void {
    $st = $pdo->prepare('INSERT INTO settings (`key`, value) VALUES (?, ?)
                         ON DUPLICATE KEY UPDATE value = VALUES(value)');
    foreach ($kv as $k => $v) $st->execute([$k, (string)$v]);
}

function theraConfig(PDO $pdo): array {
    $rows = [];
    $st = $pdo->query("SELECT `key`, value FROM settings WHERE `key` LIKE 'thera\\_%'");
    foreach ($st->fetchAll(PDO::FETCH_ASSOC) as $r) $rows[$r['key']] = $r['value'];

    // Pollsleutel is het wachtwoord voor de cron; één keer genereren en bewaren.
    $key = $rows['thera_poll_key'] ?? '';
    if ($key === '') {
        $key = bin2hex(random_bytes(12));
        theraSet($pdo, ['thera_poll_key' => $key]);
    }

    $regions = json_decode($rows['thera_regions'] ?? '', true);
    if (!is_array($regions) || !$regions) $regions = ES_REGIONS_DEF;

    return [
        'enabled'   => ($rows['thera_enabled'] ?? '1') === '1',
        'webhook'   => trim((string)($rows['thera_webhook'] ?? '')),
        'ping'      => trim((string)($rows['thera_ping'] ?? '')),
        'home'      => (int)($rows['thera_home'] ?? ES_HOME_DEF),
        'max_jumps' => max(0, min(ES_BFS_MAX, (int)($rows['thera_max_jumps'] ?? ES_JUMPS_DEF))),
        'regions'   => array_values(array_map('intval', $regions)),
        'melden_dicht' => ($rows['thera_melden_dicht'] ?? '0') === '1',
        'poll_key'  => $key,
    ];
}

// ---------------------------------------------------------------- statische kaart
/** systems.json → [id => [naam, sec, region_id]] (staat naast dit script in de webroot). */
function theraSystems(): array {
    static $cache = null;
    if ($cache !== null) return $cache;
    $raw = @file_get_contents(__DIR__ . '/../systems.json');
    $d = $raw ? json_decode($raw, true) : null;
    return $cache = is_array($d) ? $d : [];
}

/** system-jumps.json → [id => [buur-id, …]]. */
function theraJumpMap(): array {
    static $cache = null;
    if ($cache !== null) return $cache;
    $raw = @file_get_contents(__DIR__ . '/../system-jumps.json');
    $d = $raw ? json_decode($raw, true) : null;
    return $cache = is_array($d) ? $d : [];
}

/** Sprongen vanaf $home via poorten (BFS), tot maximaal $max diep. [id => sprongen]. */
function theraAfstanden(int $home, int $max): array {
    $map = theraJumpMap();
    if (!$map || !isset($map[(string)$home])) return [];
    $dist = [$home => 0];
    $laag = [$home];
    for ($d = 1; $d <= $max && $laag; $d++) {
        $volgende = [];
        foreach ($laag as $sid) {
            foreach (($map[(string)$sid] ?? []) as $buur) {
                $buur = (int)$buur;
                if (isset($dist[$buur])) continue;
                $dist[$buur] = $d;
                $volgende[] = $buur;
            }
        }
        $laag = $volgende;
    }
    return $dist;
}

// ---------------------------------------------------------------- feed
function theraFeed(): ?array {
    $ch = curl_init(ES_URL);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 20,
        CURLOPT_HTTPHEADER     => ['Accept: application/json', 'User-Agent: ' . ES_UA],
    ]);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($code !== 200 || !$body) return null;
    $d = json_decode($body, true);
    return is_array($d) ? $d : null;
}

/**
 * Feed ophalen, de interessante gaten eruit filteren en in de DB bijwerken.
 * Retourneert [aantal_gezien, aantal_nieuw, aantal_gesloten] of null bij een fout.
 */
function theraVervers(PDO $pdo, array $cfg): ?array {
    $feed = theraFeed();
    if ($feed === null) return null;

    $systems = theraSystems();
    $dist    = $cfg['max_jumps'] > 0 ? theraAfstanden($cfg['home'], $cfg['max_jumps']) : [];
    $regios  = array_flip($cfg['regions']);
    $now     = time();

    $gezien = [];
    $ins = $pdo->prepare(
        'INSERT INTO thera_sigs
            (sig_id, system_id, system_name, region_id, region_name, sec, jumps, out_system,
             in_sig, out_sig, wh_type, max_size, gemeld_door, expires_at, first_seen, last_seen)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())
         ON DUPLICATE KEY UPDATE
            last_seen = UTC_TIMESTAMP(), closed_at = NULL, jumps = VALUES(jumps),
            expires_at = VALUES(expires_at), max_size = VALUES(max_size), in_sig = VALUES(in_sig)');

    foreach ($feed as $s) {
        if (($s['signature_type'] ?? '') !== 'wormhole') continue;

        // De k-space kant is normaal `in_*` (out_* is Thera/Turnur), maar we
        // kiezen defensief de kant die binnen ons zoekgebied valt.
        $kanten = [
            ['sid' => (int)($s['in_system_id'] ?? 0),  'naam' => (string)($s['in_system_name'] ?? ''),
             'rid' => (int)($s['in_region_id'] ?? 0),  'rnaam' => (string)($s['in_region_name'] ?? ''),
             'sig' => (string)($s['in_signature'] ?? ''), 'andere' => (string)($s['out_system_name'] ?? ''),
             'andersig' => (string)($s['out_signature'] ?? '')],
            ['sid' => (int)($s['out_system_id'] ?? 0), 'naam' => (string)($s['out_system_name'] ?? ''),
             'rid' => 0, 'rnaam' => '',
             'sig' => (string)($s['out_signature'] ?? ''), 'andere' => (string)($s['in_system_name'] ?? ''),
             'andersig' => (string)($s['in_signature'] ?? '')],
        ];

        foreach ($kanten as $k) {
            $sid = $k['sid'];
            if (!$sid) continue;
            $sys = $systems[(string)$sid] ?? null;
            $rid = $k['rid'] ?: (int)($sys[2] ?? 0);
            $sprongen = $dist[$sid] ?? null;

            $inRegio = isset($regios[$rid]);
            $dichtbij = $sprongen !== null && $sprongen <= $cfg['max_jumps'];
            if (!$inRegio && !$dichtbij) continue;

            $exp = !empty($s['expires_at']) ? strtotime($s['expires_at']) : null;
            $ins->execute([
                (string)($s['id'] ?? ''),
                $sid,
                $sys[0] ?? $k['naam'],
                $rid,
                $k['rnaam'] ?: theraRegioNaam($rid),
                round((float)($sys[1] ?? 0), 2),
                $sprongen,
                $k['andere'],
                $k['sig'],
                $k['andersig'],
                (string)($s['wh_type'] ?? ''),
                (string)($s['max_ship_size'] ?? ''),
                (string)($s['created_by_name'] ?? ''),
                $exp ? gmdate('Y-m-d H:i:s', $exp) : null,
            ]);
            $gezien[] = (string)($s['id'] ?? '');
            break;   // één kant per signature is genoeg
        }
    }

    // Alles wat níet meer in de feed staat is gesloten (of verlopen).
    if ($gezien) {
        $in = implode(',', array_fill(0, count($gezien), '?'));
        $st = $pdo->prepare("UPDATE thera_sigs SET closed_at = UTC_TIMESTAMP()
                             WHERE closed_at IS NULL AND sig_id NOT IN ($in)");
        $st->execute($gezien);
        $dicht = $st->rowCount();
    } else {
        $dicht = $pdo->exec("UPDATE thera_sigs SET closed_at = UTC_TIMESTAMP() WHERE closed_at IS NULL");
    }

    theraSet($pdo, ['thera_last_poll' => (string)$now]);
    return [count($gezien), 0, (int)$dicht];
}

function theraRegioNaam(int $rid): string {
    static $regs = null;
    if ($regs === null) {
        $raw = @file_get_contents(__DIR__ . '/../regions.json');
        $d = $raw ? json_decode($raw, true) : null;
        $regs = is_array($d) ? $d : [];
    }
    $r = $regs[(string)$rid] ?? null;
    return is_array($r) ? (string)($r[0] ?? '') : (string)($r ?? '');
}

// ---------------------------------------------------------------- Discord
function discordPost(string $webhook, array $payload): bool {
    if (!preg_match('#^https://(discord\.com|discordapp\.com)/api/webhooks/#i', $webhook)) return false;
    $ch = curl_init($webhook);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 15,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'User-Agent: ' . ES_UA],
    ]);
    curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return $code >= 200 && $code < 300;
}

function dotlan(string $sys): string {
    return 'https://evemaps.dotlan.net/system/' . rawurlencode(str_replace(' ', '_', $sys));
}

/** Discord-bericht voor één nieuw gat. */
function theraEmbed(array $r, array $cfg, string $homeNaam): array {
    $jumps = $r['jumps'] === null ? null : (int)$r['jumps'];
    $kleur = ($jumps !== null && $jumps <= 3) ? ES_KLEUR_DICHT
           : (in_array((int)$r['region_id'], $cfg['regions'], true) ? ES_KLEUR_REGIO : ES_KLEUR_VER);

    $maat  = ES_MAAT[$r['max_size']] ?? ($r['max_size'] ?: 'onbekend');
    $afst  = $jumps === null ? 'meer dan ' . $cfg['max_jumps'] . ' sprongen'
                             : ($jumps === 0 ? 'in ' . $homeNaam . ' zelf' : $jumps . ' sprongen van ' . $homeNaam);
    $exp   = $r['expires_at'] ? strtotime($r['expires_at'] . ' UTC') : null;

    return [
        'title'       => '🌀 ' . $r['out_system'] . ' → ' . $r['system_name'],
        'url'         => 'https://www.eve-scout.com/#/',
        'color'       => $kleur,
        'description' => 'Nieuwe verbinding vanuit **' . $r['out_system'] . '** komt uit in **'
                       . $r['system_name'] . '** (' . ($r['region_name'] ?: 'onbekende regio') . ') — ' . $afst . '.',
        'fields'      => [
            ['name' => 'Systeem',   'value' => '[' . $r['system_name'] . '](' . dotlan($r['system_name']) . ') · ' . number_format((float)$r['sec'], 1), 'inline' => true],
            ['name' => 'Afstand',   'value' => $afst, 'inline' => true],
            ['name' => 'Max schip', 'value' => $maat, 'inline' => true],
            ['name' => 'Signature', 'value' => '`' . ($r['in_sig'] ?: '???') . '` in ' . $r['system_name']
                                             . "\n`" . ($r['out_sig'] ?: '???') . '` in ' . $r['out_system'], 'inline' => true],
            ['name' => 'Gattype',   'value' => $r['wh_type'] ?: '—', 'inline' => true],
            ['name' => 'Verloopt',  'value' => $exp ? '<t:' . $exp . ':R>' : 'onbekend', 'inline' => true],
        ],
        'footer'    => ['text' => 'EVE-Scout' . ($r['gemeld_door'] ? ' · gescout door ' . $r['gemeld_door'] : '')],
        'timestamp' => gmdate('c'),
    ];
}

/**
 * Stuur alle nog niet gemelde gaten naar Discord. De claim gebeurt met een
 * UPDATE … WHERE notified_at IS NULL, zodat twee gelijktijdige pollers nooit
 * hetzelfde gat dubbel posten.
 */
function theraMeld(PDO $pdo, array $cfg): int {
    if (!$cfg['enabled'] || $cfg['webhook'] === '') return 0;

    $rows = $pdo->query("SELECT * FROM thera_sigs
                         WHERE notified_at IS NULL AND closed_at IS NULL
                           AND first_seen > (UTC_TIMESTAMP() - INTERVAL 6 HOUR)
                         ORDER BY jumps IS NULL, jumps ASC LIMIT 10")->fetchAll(PDO::FETCH_ASSOC);
    if (!$rows) {
        // Oude, nooit gemelde gaten niet alsnog posten — alleen stil afvinken.
        $pdo->exec("UPDATE thera_sigs SET notified_at = UTC_TIMESTAMP()
                    WHERE notified_at IS NULL AND first_seen <= (UTC_TIMESTAMP() - INTERVAL 6 HOUR)");
        return 0;
    }

    $systems  = theraSystems();
    $homeNaam = $systems[(string)$cfg['home']][0] ?? ('#' . $cfg['home']);
    $claim    = $pdo->prepare('UPDATE thera_sigs SET notified_at = UTC_TIMESTAMP()
                               WHERE sig_id = ? AND notified_at IS NULL');
    $terug    = $pdo->prepare('UPDATE thera_sigs SET notified_at = NULL WHERE sig_id = ?');

    $n = 0;
    foreach ($rows as $r) {
        $claim->execute([$r['sig_id']]);
        if ($claim->rowCount() !== 1) continue;   // iemand anders was ons voor

        $payload = ['embeds' => [theraEmbed($r, $cfg, $homeNaam)]];
        if ($cfg['ping'] !== '') {
            $payload['content'] = $cfg['ping'];
            $payload['allowed_mentions'] = ['parse' => ['roles', 'everyone']];
        }
        if (discordPost($cfg['webhook'], $payload)) $n++;
        else $terug->execute([$r['sig_id']]);      // mislukt → volgende ronde opnieuw
    }
    return $n;
}

// ---------------------------------------------------------------- lijst
function theraLijst(PDO $pdo, array $cfg): array {
    $rows = $pdo->query("SELECT * FROM thera_sigs
                         WHERE closed_at IS NULL
                         ORDER BY jumps IS NULL, jumps ASC, expires_at ASC")->fetchAll(PDO::FETCH_ASSOC);
    $recent = $pdo->query("SELECT * FROM thera_sigs
                           WHERE closed_at IS NOT NULL AND closed_at > (UTC_TIMESTAMP() - INTERVAL 3 HOUR)
                           ORDER BY closed_at DESC LIMIT 15")->fetchAll(PDO::FETCH_ASSOC);

    $vorm = function (array $r): array {
        return [
            'sig_id'    => $r['sig_id'],
            'system_id' => (int)$r['system_id'],
            'system'    => $r['system_name'],
            'region_id' => (int)$r['region_id'],
            'region'    => $r['region_name'],
            'sec'       => round((float)$r['sec'], 1),
            'jumps'     => $r['jumps'] === null ? null : (int)$r['jumps'],
            'out_system'=> $r['out_system'],
            'in_sig'    => $r['in_sig'],
            'out_sig'   => $r['out_sig'],
            'wh_type'   => $r['wh_type'],
            'max_size'  => $r['max_size'],
            'maat'      => ES_MAAT[$r['max_size']] ?? $r['max_size'],
            'door'      => $r['gemeld_door'],
            'expires_at'=> $r['expires_at'] ? gmdate('c', strtotime($r['expires_at'] . ' UTC')) : null,
            'first_seen'=> gmdate('c', strtotime($r['first_seen'] . ' UTC')),
            'closed_at' => $r['closed_at'] ? gmdate('c', strtotime($r['closed_at'] . ' UTC')) : null,
        ];
    };

    $systems = theraSystems();
    $open = array_map($vorm, $rows);
    return [
        'ok'         => true,
        'rows'       => $open,
        'gesloten'   => array_map($vorm, $recent),
        'aantal'     => count($open),
        'dichtbij'   => count(array_filter($open, fn($r) => $r['jumps'] !== null && $r['jumps'] <= 3)),
        'in_regio'   => count(array_filter($open, fn($r) => in_array($r['region_id'], $cfg['regions'], true))),
        'home'       => $cfg['home'],
        'home_naam'  => $systems[(string)$cfg['home']][0] ?? ('#' . $cfg['home']),
        'max_jumps'  => $cfg['max_jumps'],
        'regios'     => array_map(fn($r) => ['id' => $r, 'naam' => theraRegioNaam($r)], $cfg['regions']),
        'discord'    => $cfg['enabled'] && $cfg['webhook'] !== '',
        'bijgewerkt' => gmdate('c'),
    ];
}

// ---------------------------------------------------------------- route
$pdo = getDB();
theraSchema($pdo);
$cfg    = theraConfig($pdo);
$actie  = $_GET['action'] ?? 'list';
$body   = json_decode(file_get_contents('php://input'), true) ?: [];

if ($actie === 'config' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    requireAdmin($body);
    $kv = [];
    if (array_key_exists('webhook', $body)) {
        $w = trim((string)$body['webhook']);
        if ($w !== '' && !preg_match('#^https://(discord\.com|discordapp\.com)/api/webhooks/#i', $w)) {
            http_response_code(400); echo json_encode(['error' => 'Geen geldige Discord-webhook-URL.']); exit;
        }
        $kv['thera_webhook'] = $w;
    }
    if (array_key_exists('ping', $body))      $kv['thera_ping']      = mb_substr(trim((string)$body['ping']), 0, 64);
    if (array_key_exists('enabled', $body))   $kv['thera_enabled']   = !empty($body['enabled']) ? '1' : '0';
    if (array_key_exists('home', $body))      $kv['thera_home']      = (int)$body['home'] ?: ES_HOME_DEF;
    if (array_key_exists('maxJumps', $body))  $kv['thera_max_jumps'] = max(0, min(ES_BFS_MAX, (int)$body['maxJumps']));
    if (array_key_exists('regions', $body)) {
        $regs = array_values(array_unique(array_filter(array_map('intval', (array)$body['regions']))));
        $kv['thera_regions'] = json_encode(array_slice($regs, 0, 12));
    }
    theraSet($pdo, $kv);
    echo json_encode(['ok' => true]);
    exit;
}

if ($actie === 'config') {
    requireAdmin();
    $cfg = theraConfig($pdo);
    echo json_encode([
        'ok'        => true,
        'enabled'   => $cfg['enabled'],
        'webhook'   => $cfg['webhook'],
        'ping'      => $cfg['ping'],
        'home'      => $cfg['home'],
        'maxJumps'  => $cfg['max_jumps'],
        'regions'   => $cfg['regions'],
        'pollUrl'   => 'https://dutchlegionsdashboard.eu/api/thera.php?action=poll&key=' . $cfg['poll_key'],
    ]);
    exit;
}

if ($actie === 'test') {
    requireAdmin();
    if ($cfg['webhook'] === '') { http_response_code(400); echo json_encode(['error' => 'Nog geen webhook ingesteld.']); exit; }
    $systems = theraSystems();
    $ok = discordPost($cfg['webhook'], ['embeds' => [theraEmbed([
        'system_name' => $systems[(string)$cfg['home']][0] ?? 'Delve', 'region_name' => 'Delve',
        'region_id' => 10000060, 'sec' => -0.4, 'jumps' => 0, 'out_system' => 'Thera',
        'in_sig' => 'ABC-123', 'out_sig' => 'XYZ-789', 'wh_type' => 'V898', 'max_size' => 'xlarge',
        'gemeld_door' => 'testbericht', 'expires_at' => gmdate('Y-m-d H:i:s', time() + 16 * 3600),
    ], $cfg, $systems[(string)$cfg['home']][0] ?? 'staging')]]);
    echo json_encode(['ok' => $ok] + ($ok ? [] : ['error' => 'Discord weigerde het bericht.']));
    exit;
}

if ($actie === 'poll') {
    $key = (string)($_GET['key'] ?? '');
    if (!hash_equals($cfg['poll_key'], $key) && !authCharId()) {
        http_response_code(403); echo json_encode(['error' => 'forbidden']); exit;
    }
    $res = theraVervers($pdo, $cfg);
    if ($res === null) { http_response_code(502); echo json_encode(['error' => 'EVE-Scout onbereikbaar']); exit; }
    $gemeld = theraMeld($pdo, $cfg);
    echo json_encode(['ok' => true, 'gezien' => $res[0], 'gesloten' => $res[2], 'gemeld' => $gemeld, 'tijd' => gmdate('c')]);
    exit;
}

// action=list — ververst zelf als de feed ouder is dan ES_TTL, zodat de pagina
// ook zonder cron actueel is (en dan meteen meldt wat nieuw is).
$laatst = 0;
$st = $pdo->prepare("SELECT value FROM settings WHERE `key` = 'thera_last_poll'");
$st->execute();
$laatst = (int)$st->fetchColumn();
if (!empty($_GET['refresh']) || (time() - $laatst) > ES_TTL) {
    if (theraVervers($pdo, $cfg) !== null) theraMeld($pdo, $cfg);
}
echo json_encode(theraLijst($pdo, $cfg));
