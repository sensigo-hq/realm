# py_capture.py — Python 3's default printers over the FAKE inputs named on the command line
# (a JSON object: case id -> value). Writes one JSON line per (printer, case): {"p", "c", "out"}.
import json, sys, io, logging, base64, html, shlex, csv, pprint, urllib.parse, xml.sax.saxutils as sax
import yaml, subprocess

cases = json.load(open(sys.argv[1], encoding='utf-8'))

def log_capture(fmt_args):
    buf = io.StringIO()
    h = logging.StreamHandler(buf)
    h.setFormatter(logging.Formatter(logging.BASIC_FORMAT))  # basicConfig's default format
    lg = logging.getLogger('cap'); lg.handlers = [h]; lg.propagate = False
    lg.warning(*fmt_args)
    return buf.getvalue().rstrip('\n')

def csv_field(s):
    buf = io.StringIO(); csv.writer(buf).writerow([s]); return buf.getvalue().rstrip('\r\n')

printers = {
    'py.repr': repr,
    'py.ascii': ascii,
    'py.pct_r': lambda s: '%r' % (s,),
    'py.fstr_r': lambda s: f'{s!r}',
    'py.str_dict': lambda s: str({'k': s}),
    'py.str_list': lambda s: str([s]),
    'py.str_KeyError': lambda s: str(KeyError(s)),
    'py.unicode_escape': lambda s: s.encode('unicode_escape').decode('ascii'),
    'py.repr_bytes': lambda s: repr(s.encode('utf-8', 'surrogatepass')),
    'py.json_dumps': lambda s: json.dumps(s),
    'py.json_dumps_noascii': lambda s: json.dumps(s, ensure_ascii=False),
    'py.logging_pct_s': lambda s: log_capture(('token %s', s)),
    'py.logging_dict': lambda s: log_capture(('cfg %s', {'k': s})),
    'py.pprint_dict': lambda s: pprint.pformat({'k': s}),
    'py.quote': urllib.parse.quote,
    'py.quote_safe_empty': lambda s: urllib.parse.quote(s, safe=''),
    'py.quote_plus': urllib.parse.quote_plus,
    'py.urlencode': lambda s: urllib.parse.urlencode({'k': s}),
    'py.b64': lambda s: base64.b64encode(s.encode('utf-8', 'surrogatepass')).decode(),
    'py.b64url': lambda s: base64.urlsafe_b64encode(s.encode('utf-8', 'surrogatepass')).decode(),
    'py.hex': lambda s: s.encode('utf-8', 'surrogatepass').hex(),
    'py.html_escape': html.escape,
    'py.html_escape_noquote': lambda s: html.escape(s, quote=False),
    'py.sax_escape': sax.escape,
    'py.sax_quoteattr': sax.quoteattr,
    'py.shlex_quote': shlex.quote,
    'py.list2cmdline': lambda s: subprocess.list2cmdline([s]),
    'py.json_dumps_twice': lambda s: json.dumps(json.dumps(s)),
    'py.json_of_repr': lambda s: json.dumps({'e': 'bad token ' + repr(s)}),
    'py.json_of_str_dict': lambda s: json.dumps({'e': str({'k': s})}),
    'py.csv': csv_field,
    'py.yaml_safe_dump_dict': lambda s: yaml.safe_dump({'k': s}),
    'py.yaml_safe_dump_dict_unicode': lambda s: yaml.safe_dump({'k': s}, allow_unicode=True),
}

for pname, fn in printers.items():
    for cname, val in cases.items():
        try:
            out = fn(val)
        except Exception as e:  # record the failure, never the value
            out = 'ERROR ' + type(e).__name__
        print(json.dumps({'p': pname, 'c': cname, 'out': out}))
