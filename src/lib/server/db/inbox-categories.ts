import { inboxCategoryRules } from '$lib/domain/mail/categories';

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** Inputs are trusted SQL column expressions, never request values. */
export function inboxCategorySql(from: string, subject: string, override: string): string {
  const sender = `lower(trim(CASE WHEN instr(${from}, '<') > 0 AND instr(${from}, '>') > instr(${from}, '<')
    THEN substr(${from}, instr(${from}, '<') + 1, instr(${from}, '>') - instr(${from}, '<') - 1) ELSE ${from} END))`;
  const rules = inboxCategoryRules.map((rule) => {
    const predicates = [
      ...(rule.senderDomains ?? []).flatMap((domain) => [
        `substr(${sender}, -${domain.length + 1}) = ${literal(`@${domain}`)}`,
        `substr(${sender}, -${domain.length + 1}) = ${literal(`.${domain}`)}`
      ]),
      ...(rule.senderPrefixes ?? []).map((prefix) => `substr(${sender}, 1, ${prefix.length}) = ${literal(prefix)}`),
      ...(rule.subjectPhrases ?? []).map((phrase) => /^[a-z]/u.test(phrase)
        ? `(' ' || lower(${subject}) || ' ') GLOB ${literal(`*[^a-z0-9]${phrase}[^a-z0-9]*`)}`
        : `instr(lower(${subject}), ${literal(phrase)}) > 0`)
    ];
    return `WHEN (${predicates.join(' OR ')}) THEN ${literal(rule.category)}`;
  });
  return `COALESCE(${override}, CASE ${rules.join(' ')} ELSE 'primary' END)`;
}
