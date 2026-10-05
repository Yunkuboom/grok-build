import { isValidElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import CopyButton from './CopyButton';
import { t } from '../i18n';


function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement(node)) {
    return extractText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

function PreBlock({ children }: { children?: ReactNode }) {
  return (
    <div className="codeblock-wrap">
      <pre>{children}</pre>
      <CopyButton
        className="codeblock-copy"
        text={extractText(children).replace(/\n$/, '')}
        title={t('复制代码', 'Copy code')}
        size={13}
      />
    </div>
  );
}

/** 共享 markdown 渲染：GFM + 代码块常驻复制按钮 */
export default function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: PreBlock }}>
      {children}
    </ReactMarkdown>
  );
}
