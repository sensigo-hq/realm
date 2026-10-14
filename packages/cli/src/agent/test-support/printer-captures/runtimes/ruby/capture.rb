# Ruby capture (printer captures, FAKE values only). Reads {c, v} JSON lines on stdin; writes {p, c, hex (bytes), enc}.
# The tag (ARGV[0]) names the locale the run used: String#inspect keeps non-ASCII raw only when the default
# external (or internal) encoding is the string's own (UTF-8).
require 'json'
require 'cgi'
tag = ARGV[0] || ''
$stdout.binmode
$stdin.set_encoding('UTF-8')
puts JSON.generate({ p: 'meta' + tag, c: '-', ruby: RUBY_VERSION, json: JSON::VERSION, cgi: (defined?(CGI::Escape) ? 'cgi/escape' : 'cgi'),
                     default_external: Encoding.default_external.to_s, default_internal: Encoding.default_internal.to_s,
                     unicode: RbConfig::CONFIG['UNICODE_VERSION'] })
$stdin.each_line do |line|
  line = line.chomp
  next if line.empty?
  inp = JSON.parse(line)
  v = inp['v']; c = inp['c']
  e = lambda do |p, &blk|
    begin
      out = blk.call
      puts JSON.generate({ p: p + tag, c: c, hex: out.b.unpack1('H*'), enc: out.encoding.to_s })
    rescue => ex
      puts JSON.generate({ p: p + tag, c: c, hex: '', err: ex.class.to_s + ': ' + ex.message.b.unpack1('H*') })
    end
  end
  e.call('ruby.inspect') { v.inspect }
  e.call('ruby.inspect_hash') { { 'k' => v }.inspect }
  e.call('ruby.to_json') { v.to_json }
  e.call('ruby.JSON.generate_obj') { JSON.generate({ 'k' => v }) }
  e.call('ruby.CGI.escapeHTML') { CGI.escapeHTML(v) }
end
