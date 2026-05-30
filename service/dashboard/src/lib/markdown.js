// markdown.js — light Markdown → HTML renderer used by the dashboard's chat
// bubbles, transcript view, and xterm assistant-output styling. Lifted out of
// terminal/+page.svelte L860 during the Shape-2 refactor so multiple panels
// can use it without prop-drilling.
//
// CAUTION: the output is fed to {@html ...} in Svelte / innerHTML in xterm —
// we HTML-escape input first to neutralise stray tags. Don't widen the
// escape set without thinking about whether the chat models can produce it.

export function renderMarkdown(text) {
	if (!text) return '';
	// Escape HTML first
	let html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	// Code blocks (```...```) — must come before inline code
	html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre class="md-codeblock"><code>$2</code></pre>');
	// Tables — detect consecutive lines starting with |
	const lines = html.split('\n');
	let tableStart = -1;
	for (let i = 0; i <= lines.length; i++) {
		const trimmed = i < lines.length ? lines[i].trim() : '';
		const isTableLine = trimmed.startsWith('|') && trimmed.includes('|', 1);
		if (isTableLine && tableStart === -1) tableStart = i;
		if (!isTableLine && tableStart !== -1) {
			const tableLines = lines.slice(tableStart, i).map(l => l.trim());
			if (tableLines.length >= 2) {
				const sepCells = tableLines[1].split('|').slice(1).map(c => c.trim()).filter(c => c);
				const isSep = sepCells.length > 0 && sepCells.every(c => /^[\s\-:]+$/.test(c));
				const dataRows = isSep ? [tableLines[0], ...tableLines.slice(2)] : tableLines;
				let table = '<div class="md-table-wrap"><table class="md-table">';
				dataRows.forEach((row, ri) => {
					const cells = row.split('|').slice(1).map(c => c.trim()).filter((c, ci, arr) => ci < arr.length - 1 || c !== '');
					const tag = (ri === 0 && isSep) ? 'th' : 'td';
					table += '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
				});
				table += '</table></div>';
				lines.splice(tableStart, i - tableStart, table);
				i = tableStart + 1;
			}
			tableStart = -1;
		}
	}
	html = lines.join('\n');
	// Inline code (`...`)
	html = html.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
	// Bold (**...**)
	html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
	// Italic (*...*)
	html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
	// Headings (## ...)
	html = html.replace(/^### (.+)$/gm, '<div class="md-h3">$1</div>');
	html = html.replace(/^## (.+)$/gm, '<div class="md-h2">$1</div>');
	html = html.replace(/^# (.+)$/gm, '<div class="md-h1">$1</div>');
	// Bullet lists (- item or * item)
	html = html.replace(/^[\-\*] (.+)$/gm, '<div class="md-bullet">$1</div>');
	// Numbered lists (1. item)
	html = html.replace(/^\d+\. (.+)$/gm, '<div class="md-bullet md-numbered">$1</div>');
	// Line breaks
	html = html.replace(/\n/g, '<br>');
	// Clean up <br> after block elements
	html = html.replace(/(<\/div>)<br>/g, '$1');
	html = html.replace(/(<\/pre>)<br>/g, '$1');
	html = html.replace(/(<\/table>)<br>/g, '$1');
	return html;
}
