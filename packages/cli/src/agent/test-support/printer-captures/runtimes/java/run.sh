# runs inside eclipse-temurin:21-jdk; files arrive by stdin (mkbundle.mjs). Jars from Maven Central / repo.jenkins-ci.org.
set -e
cd /w && mkdir -p lib
M=https://repo1.maven.org/maven2
GSON=2.14.0; J2=2.22.3; J3=3.2.3; ANN=2.22; JK=728.v902a_273b_8947
for u in $M/com/google/code/gson/gson/$GSON/gson-$GSON.jar \
  $M/com/fasterxml/jackson/core/jackson-core/$J2/jackson-core-$J2.jar \
  $M/com/fasterxml/jackson/core/jackson-databind/$J2/jackson-databind-$J2.jar \
  $M/com/fasterxml/jackson/core/jackson-annotations/$ANN/jackson-annotations-$ANN.jar \
  $M/tools/jackson/core/jackson-core/$J3/jackson-core-$J3.jar \
  $M/tools/jackson/core/jackson-databind/$J3/jackson-databind-$J3.jar \
  https://repo.jenkins-ci.org/releases/org/jenkins-ci/plugins/credentials-binding/$JK/credentials-binding-$JK.jar; do
  curl -fsSL -o lib/$(basename $u) $u </dev/null
done
sha256sum lib/*.jar >&2
java -version 2>&1 | head -1 >&2
mkdir -p stubout && javac -d stubout stubs/hudson/*.java
CP="lib/*:stubout:."
javac -cp "$CP" -nowarn -Xlint:none Cap.java 2>&1 | grep -v "^Note:" >&2 || true
# record that the jar's Bash/Batch regexes are the pinned source's
cd /tmp && jar xf /w/lib/credentials-binding-$JK.jar org/jenkinsci/plugins/credentialsbinding/masking && cd /w
javap -v -p /tmp/org/jenkinsci/plugins/credentialsbinding/masking/BashSecretPatternFactory.class | grep -E "= String|String (\(|'|\\\\)" | head -8 >&2
javap -v -p /tmp/org/jenkinsci/plugins/credentialsbinding/masking/BatchSecretPatternFactory.class | grep -E "= String" | head -8 >&2
java -cp "$CP" Cap < /w/inputs.jsonl
