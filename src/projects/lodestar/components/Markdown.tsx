/**
 * Markdown renderer for agent replies — SWITCHBOARD COPY. Lodestar rendered
 * these with react-markdown + its own element styling; here the shell's ONE
 * markdown pipeline (page-api MarkdownDoc: remark → rehype-slug → the link
 * policy that never lets a doc link navigate the privileged webview) does the
 * job, so an agent reply, a KB doc and a README all read the same and all
 * obey the same safety rules. Same `text` prop as before.
 */

import { MarkdownDoc } from "../../../surfaces/page-api";

export default function Markdown({ text }: { text: string }) {
  return (
    <div className="break-words">
      <MarkdownDoc content={text} />
    </div>
  );
}
