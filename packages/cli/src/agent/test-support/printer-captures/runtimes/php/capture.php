<?php
// PHP capture (printer captures, FAKE values only). Reads {c, v} JSON lines on stdin; writes {p, c, hex, err}.
$meta = ['p' => 'meta', 'c' => '-', 'php' => PHP_VERSION, 'htmlspecialchars_default_flags' => 'ENT_QUOTES|ENT_SUBSTITUTE|ENT_HTML401 (8.1+ doc)'];
echo json_encode($meta), "\n";
while (($line = fgets(STDIN)) !== false) {
    $line = rtrim($line, "\n");
    if ($line === '') continue;
    $in = json_decode($line, true);
    if (!is_array($in)) { echo json_encode(['p' => 'input_error', 'c' => '?', 'err' => json_last_error_msg()]), "\n"; continue; }
    $v = $in['v']; $c = $in['c'];
    $e = function ($p, $out) use ($c) {
        $row = ['p' => $p, 'c' => $c, 'hex' => is_string($out) ? bin2hex($out) : '', 'err' => is_string($out) ? null : ('returned ' . var_export($out, true) . '; ' . json_last_error_msg())];
        echo json_encode($row), "\n";
    };
    $e('php.json_encode', json_encode($v));
    $e('php.json_encode_UU_ULT', json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_LINE_TERMINATORS));
    $e('php.json_encode_UU', json_encode($v, JSON_UNESCAPED_UNICODE));
    $e('php.json_encode_US', json_encode($v, JSON_UNESCAPED_SLASHES));
    $e('php.json_encode_UU_US', json_encode($v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    $e('php.json_encode_obj', json_encode(['k' => $v]));
    $e('php.addslashes', addslashes($v));
    $e('php.urlencode', urlencode($v));
    $e('php.rawurlencode', rawurlencode($v));
    $e('php.http_build_query', http_build_query(['k' => $v]));
    $e('php.htmlspecialchars', htmlspecialchars($v));
    $e('php.var_export', var_export($v, true));
}
