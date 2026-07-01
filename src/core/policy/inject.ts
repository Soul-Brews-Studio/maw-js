/**
 * Policy inject builder — assembles the company + dept policy context that the
 * `company-policy.sh` UserPromptSubmit hook pushes back into an oracle's Claude
 * Code session, but ONLY while the oracle is currently attached.
 *
 * This is the dynamic, attach-gated counterpart of the static "Department" block
 * that used to live in CLAUDE.md (decision 6): when attached, the oracle's
 * identity header + company/dept policy are injected live; when detached, nothing
 * is injected and the oracle has no company policy in context.
 *
 * Returns "" (and the hook injects nothing) when the oracle is not attached, has
 * no company scope, or there is simply nothing to inject.
 */

import { isPolicyAttached } from "./attach-store";
import { scopeOfOracle } from "../worklog/company-scope";
import { loadCompany, kbTagFor } from "../../vendor/mpr-plugins/company/company-helpers";
import { readCompanyPolicy, readDeptPolicy } from "./policy-store";

export function buildPolicyInject(oracle: string): string {
  if (!isPolicyAttached(oracle)) return "";

  const scope = scopeOfOracle(oracle);
  if (!scope) return "";

  const { company, dept, lead } = scope;

  // Identity header — the dept identity moved out of the static CLAUDE.md block.
  // A company-level manager (dept === null) gets the company header + company
  // policy only — no dept role/policy (they sit above the depts).
  const role = dept
    ? loadCompany(company)?.departments[dept]?.members.find(m => m.oracle === oracle)?.role ?? null
    : "manager";
  const header = [
    dept
      ? "## Department (company policy — active while attached)"
      : "## Company (policy — active while attached)",
    `- Company: ${company}`,
    ...(dept ? [`- Department: ${dept} (${kbTagFor(company, dept)})`] : []),
    `- Role: ${role ?? "—"}`,
    ...(lead ? [`- Lead: ${lead}`] : []),
  ].join("\n");

  const sections = [header];

  const companyPolicy = readCompanyPolicy(company);
  if (companyPolicy) sections.push(companyPolicy.trim());

  const deptPolicy = dept ? readDeptPolicy(company, dept) : null;
  if (deptPolicy) sections.push(deptPolicy.trim());

  return sections.join("\n\n");
}
