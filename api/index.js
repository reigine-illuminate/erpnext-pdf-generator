import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    const { html, configurator_options } = req.body;
    if (!html) return res.status(400).json({ error: 'Missing html in request body' });

    chromium.setGraphicsMode = false;

    // 1. LAUNCH SERVERLESS BROWSER
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    // 🐛 FIX: Force exact 8.5x11in viewport and Print CSS BEFORE measuring!
    // 8.5in * 96dpi = 816px width. 11in * 96dpi = 1056px height.
    await page.setViewport({ width: 816, height: 1056, deviceScaleFactor: 1 });
    await page.emulateMediaType('print');

    // 2. EXTRACT EXACT COORDINATES FOR EVERY INDIVIDUAL CHECKBOX
    const domCoords = await page.evaluate(() => {
      const items = document.querySelectorAll('[data-step]');
      const coords = [];
      const allWrappers = Array.from(document.querySelectorAll('.page-wrapper'));

      items.forEach(item => {
        // Target the physical square itself to bypass all padding math entirely
        const chkbx = item.querySelector('.ordering-code-chkbx');
        const targetElement = chkbx ? chkbx : item;
        
        const rect = targetElement.getBoundingClientRect();
        const pageWrapper = targetElement.closest('.page-wrapper');
        
        if (!pageWrapper) return;
        
        const pageIndex = allWrappers.indexOf(pageWrapper);
        const wrapperRect = pageWrapper.getBoundingClientRect();

        // Calculate exact distance from the top-left corner of the printed page
        const relativeLeft = rect.left - wrapperRect.left;
        const relativeTop = rect.top - wrapperRect.top;

        coords.push({
          step: item.getAttribute('data-step'),
          code: item.getAttribute('data-code'),
          pageIndex: pageIndex !== -1 ? pageIndex : allWrappers.length - 1,
          x: relativeLeft * 0.75, // 1px CSS = 0.75 PDF pt
          y: 792 - (relativeTop * 0.75) - (rect.height * 0.75),
          width: rect.width * 0.75,
          height: rect.height * 0.75
        });
      });
      return coords;
    });

    // 3. SNAP BASE PDF (Now perfectly matches coordinate extraction layout)
    const pdfBuffer = await page.pdf({ 
      format: 'Letter', 
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true
    });
    
    await browser.close();

    // 4. LOAD PDF-LIB TO STAMP INTERACTIVE ACROFORMS
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    pdfDoc.registerFontkit(fontkit);

    let customFont;
    try {
      const fontRes = await fetch('https://cdn.jsdelivr.net/npm/@fontsource/noto-serif@5.0.18/files/noto-serif-latin-600-normal.ttf');
      customFont = await pdfDoc.embedFont(await fontRes.arrayBuffer());
    } catch (err) {
      customFont = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
    }

    const form = pdfDoc.getForm();
    const pages = pdfDoc.getPages();
    const textColor = rgb(36 / 255, 36 / 255, 2 / 255);

    // --- A. HEADER TEXT INPUTS ---
    const headerConfigs = [
      { name: 'project_name', x: 79, y: 705, width: 130, height: 16 },
      { name: 'fixture_type', x: 265, y: 705, width: 130, height: 16 },
      { name: 'project_location', x: 442, y: 705, width: 140, height: 16 }
    ];

    headerConfigs.forEach(cfg => {
      const tf = form.createTextField(cfg.name);
      pages.forEach(p => {
        tf.addToPage(p, {
          x: cfg.x, y: cfg.y, width: cfg.width, height: cfg.height,
          borderWidth: 0, backgroundColor: rgb(1,1,1), textColor, font: customFont,
        });
      });
      tf.setFontSize(10);
    });

    // --- B. INTERACTIVE RADIO BUTTONS & LENGTH INPUT OVERLAYS ---
    if (Array.isArray(configurator_options)) {
      configurator_options.forEach((step) => {
        const stepStr = String(step.option_step);
        const stepName = `step_${stepStr}`;
        const stepCoords = domCoords.filter(c => c.step === stepStr);

        if (stepCoords.length === 0) return;

        if (step.option_type === "Length") {
          const lengthCoord = stepCoords[0];
          const targetPage = pages[lengthCoord.pageIndex] || pages[pages.length - 1];
          const lengthField = form.createTextField(stepName);
          
          lengthField.addToPage(targetPage, {
            x: lengthCoord.x,
            y: lengthCoord.y - 1,
            width: 65, height: 14,
            borderWidth: 0.5, borderColor: textColor, textColor, font: customFont,
          });
          lengthField.setFontSize(9);
          
        } else {
          const radioGroup = form.createRadioGroup(stepName);
          let defaultSelectedCode = null;

          let allowedValues = [];
          try { allowedValues = typeof step.allowed_values_json === 'string' ? JSON.parse(step.allowed_values_json) : step.allowed_values_json; } catch(e){}

          // Stamp the radio buttons exactly over the Webflow CSS squares
          stepCoords.forEach((coord) => {
            const targetPage = pages[coord.pageIndex] || pages[pages.length - 1];
            radioGroup.addOptionToPage(coord.code, targetPage, {
              x: coord.x, 
              y: coord.y, 
              width: coord.width || 9, 
              height: coord.height || 9, 
              borderWidth: 0, 
              borderColor: textColor,
            });
          });

          allowedValues.forEach((valObj, idx) => {
            if ((valObj.is_default === 1 || idx === 0) && !defaultSelectedCode) {
              defaultSelectedCode = String(valObj.code || valObj.value);
            }
          });
          if (defaultSelectedCode) {
            try { radioGroup.select(defaultSelectedCode); } catch(e){}
          }
        }
      });
    }

    form.updateFieldAppearances(customFont);
    const pdfBytes = await pdfDoc.save();

    return res.status(200).json({ pdf_base64: Buffer.from(pdfBytes).toString('base64') });

  } catch (error) {
    console.error('Render Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
