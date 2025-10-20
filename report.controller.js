import { Document, Packer, Paragraph, HeadingLevel, TextRun, Table, TableRow, TableCell, ExternalHyperlink } from "docx";
import fs from "fs/promises";
import path from "path";

// Chức năng: Parse Markdown sang DOCX, xử lý headings, bullets, tables, citations, Mermaid.
function parseMarkdownToDocx(markdown) {

    // Find and start from main report heading (BÁO CÁO PHÂN TÍCH CHUYÊN SÂU)
    const reportStartPattern = /(\*\*BÁO CÁO PHÂN TÍCH CHUYÊN SÂU\*\*|# BÁO CÁO PHÂN TÍCH CHUYÊN SÂU|## BÁO CÁO PHÂN TÍCH CHUYÊN SÂU)/i;
    const match = markdown.match(reportStartPattern);
    if (match) {
      // Start from the beginning of the heading line, not mid-sentence
      const startIndex = markdown.lastIndexOf('\n', markdown.indexOf(match[0]));
      markdown = markdown.substring(startIndex >= 0 ? startIndex : markdown.indexOf(match[0]));
    }
    
    // Remove wrapping triple-backticks if present
    if (markdown.trim().startsWith('```') && markdown.trim().endsWith('```')) {
      markdown = markdown.trim().replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '');
    }
  const lines = markdown.split('\n');
  const children = [];
  let inMermaid = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!line.trim()) continue;
    // Only trim heading/bullet lines, not normal text
    if (line.startsWith('#') || line.startsWith('- ') || line.startsWith('>')) {
      line = line.trim();
    }

    // Xử lý Mermaid.
    if (line.startsWith('```mermaid')) {
      inMermaid = true;
      children.push(new Paragraph({ text: "[Mermaid Chart - Not rendered in DOCX]", italic: true }));
      continue;
    }
    if (inMermaid && line.startsWith('```')) {
      inMermaid = false;
      continue;
    }
    if (inMermaid) continue;

    // Xử lý headings.
    if (line.startsWith('# ')) {
      children.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 }));
      continue;
    }
    if (line.startsWith('## ')) {
      children.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 }));
      continue;
    }
    if (line.startsWith('### ')) {
      children.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3 }));
      continue;
    }
    // Xử lý bullets.
    if (line.startsWith('- ')) {
      const text = line.slice(2);
      const linkMatch = text.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
      if (linkMatch) {
        children.push(new Paragraph({
          bullet: { level: 0 },
          children: [
            new ExternalHyperlink({
              link: linkMatch[2],
              children: [new TextRun({ text: linkMatch[1], style: "Hyperlink" })],
            }),
          ],
        }));
      } else {
        children.push(new Paragraph({ text, bullet: { level: 0 } }));
      }
      continue;
    }
    // Xử lý tables.
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const rowLine = lines[i].trim();
        if (/^\|\s*-+/.test(rowLine)) { i++; continue; } // Bỏ separator
        const cells = rowLine.split('|').map(c => c.trim()).filter(Boolean);
        rows.push(new TableRow({
          children: cells.map(c => new TableCell({ children: [new Paragraph(c)] }))
        }));
        i++;
      }
      i--; // Lùi 1 vì for sẽ +1
      if (rows.length) children.push(new Table({ rows }));
      continue;
    }
    // Xử lý inline citations [[n]](url)
    const citation = line.match(/\[\[(\d+)\]\]\((https?:\/\/[^\s)]+)\)/);
    if (citation) {
      children.push(new Paragraph({
        children: [
          new ExternalHyperlink({
            link: citation[2],
            children: [new TextRun({ text: `[#${citation[1]}]`, style: "Hyperlink" })],
          })
        ]
      }));
      continue;
    }
    // Xử lý Markdown link [text](url)
    const mdLink = line.match(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/);
    if (mdLink) {
      children.push(new Paragraph({
        children: [
          new ExternalHyperlink({
            link: mdLink[2],
            children: [new TextRun({ text: mdLink[1], style: "Hyperlink" })],
          })
        ]
      }));
      continue;
    }
    children.push(new Paragraph({ text: line }));
  }

  return children;
}

// Hàm generate report DOCX.
export async function generateReport(researchData = {}) {
  const id = researchData.id || Date.now();
  const fileName = researchData.fileName || `DeepResearch_Report_${id}.docx`;
  const outputPath = path.join("public", "reports", fileName);

  const parsedChildren = parseMarkdownToDocx(researchData.report.markdown || '');
  const doc = new Document({
    creator: "DeepResearch Bot",
    title: researchData.query || "Deep Research Report",
    description: `Báo cáo nghiên cứu sâu cho: ${researchData.query || "Không xác định"}`,
    sections: [{ children: parsedChildren }]
  });

  const buffer = await Packer.toBuffer(doc);
  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, buffer);
    console.log(`✅ Report generated at ${outputPath}`);
    return fileName;
  } catch (error) {
    console.error('❌ Lỗi ghi file:', error.message);
    throw error;
  }
}