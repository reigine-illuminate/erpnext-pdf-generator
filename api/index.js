import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { PDFDocument, rgb, StandardFonts, PDFName } from 'pdf-lib';
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

    await page.setViewport({ width: 816, height: 1056, deviceScaleFactor: 1 });
    await page.emulateMediaType('print');

    // 2. EXTRACT DOM COORDINATES, INJECT PAGINATION & FIND CODE INPUT BOX
    const domExtraction = await page.evaluate(() => {
      // --- A. INJECT DYNAMIC PAGINATION ---
      const wrappers = Array.from(document.querySelectorAll('.page-wrapper'));
      wrappers.forEach((wrapper, index) => {
        const pageNo = wrapper.querySelector('#spec-current-page-no');
        const totalNo = wrapper.querySelector('#spec-total-pages-count');
        if (pageNo) pageNo.innerText = String(index + 1);
        if (totalNo) totalNo.innerText = String(wrappers.length);
      });

      // --- B. EXTRACT CHECKBOX COORDINATES ---
      const items = document.querySelectorAll('[data-step]');
      const coords = [];

      items.forEach(item => {
        const chkbx = item.querySelector('.ordering-code-chkbx');
        const targetElement = chkbx ? chkbx : item;
        
        const rect = targetElement.getBoundingClientRect();
        const pageWrapper = targetElement.closest('.page-wrapper');
        
        if (!pageWrapper) return;
        
        const pageIndex = wrappers.indexOf(pageWrapper);
        const wrapperRect = pageWrapper.getBoundingClientRect();

        const relativeLeft = rect.left - wrapperRect.left;
        const relativeTop = rect.top - wrapperRect.top;

        coords.push({
          step: item.getAttribute('data-step'),
          code: item.getAttribute('data-code'),
          pageIndex: pageIndex !== -1 ? pageIndex : wrappers.length - 1,
          x: relativeLeft * 0.75, 
          y: 792 - (relativeTop * 0.75) - (rect.height * 0.75),
          width: rect.width * 0.75,
          height: rect.height * 0.75
        });
      });

      // --- C. EXTRACT MAIN ORDERING CODE INPUT BOX ---
      let codeBoxCoords = null;
      const codeBox = document.querySelector('#spec-ordering-code-input');
      if (codeBox) {
        const rect = codeBox.getBoundingClientRect();
        const pageWrapper = codeBox.closest('.page-wrapper');
        if (pageWrapper) {
          const wrapperRect = pageWrapper.getBoundingClientRect();
          const pageIndex = wrappers.indexOf(pageWrapper);
          
          codeBoxCoords = {
            pageIndex: pageIndex !== -1 ? pageIndex : wrappers.length - 1,
            x: (rect.left - wrapperRect.left) * 0.75,
            y: 792 - ((rect.top - wrapperRect.top) * 0.75) - (rect.height * 0.75),
            width: rect.width * 0.75,
            height: rect.height * 0.75
          };
          
          // Hide text so pdf-lib field can overlay cleanly
          codeBox.style.color = 'transparent'; 
        }
      }

      return { coords, codeBoxCoords };
    });

    // 3. SNAP BASE PDF 
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
      const fontRes = await fetch('https://cdn.jsdelivr.net/npm/@fontsource/noto-serif/files/noto-serif-latin-600-normal.ttf');
      if (!fontRes.ok) throw new Error("Font fetch failed");
      customFont = await pdfDoc.embedFont(await fontRes.arrayBuffer());
    } catch (err) {
      console.error('Failed to load Noto Serif. Falling back to Times:', err);
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
    const domCoords = domExtraction.coords;
    
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

          stepCoords.forEach((coord) => {
            const targetPage = pages[coord.pageIndex] || pages[pages.length - 1];
            radioGroup.addOptionToPage(coord.code, targetPage, {
              x: coord.x, y: coord.y, width: coord.width || 9, height: coord.height || 9, 
              borderWidth: 0, borderColor: textColor, // Keeps borders invisible
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

    // --- C. DYNAMIC ACROJS ORDERING CODE GENERATOR ---
    const codeBox = domExtraction.codeBoxCoords;
    if (codeBox && Array.isArray(configurator_options)) {
      const targetPage = pages[codeBox.pageIndex] || pages[pages.length - 1];
      const orderingCodeField = form.createTextField('SpecOrderingCode');
      
      orderingCodeField.addToPage(targetPage, {
        x: codeBox.x,
        y: codeBox.y - 2, // Slight nudge for text baseline
        width: codeBox.width,
        height: codeBox.height + 4,
        font: customFont,
        textColor: textColor,
        borderWidth: 0,
      });
      orderingCodeField.setFontSize(10);

      // Serialize product options so Acrobat JS knows exactly how to assemble the code
      const acroSteps = configurator_options.map(s => ({
        stepName: 'step_' + s.option_step,
        type: s.option_type,
        label: s.option_label || ''
      })).sort((a, b) => parseInt(a.stepName.split('_')[1]) - parseInt(b.stepName.split('_')[1]));

      // Create the Acrobat JS Engine script
      const acroCalcScript = `
        var steps = ${JSON.stringify(acroSteps)};
        var segments = [];
        var dirVal = "";
        
        for (var i = 0; i < steps.length; i++) {
          var f = this.getField(steps[i].stepName);
          if (f) {
            var val = f.valueAsString;
            // Native PDF radio buttons return 'Off' when unchecked
            if (val && val !== "Off") {
              var isDir = steps[i].type === "Feed Direction" && steps[i].label.indexOf("Direction") !== -1;
              var isLen = steps[i].type === "Feed Direction" && steps[i].label.indexOf("Length") !== -1;
              
              if (isDir) {
                dirVal = val; // Store 'E' or 'C'
              } else if (isLen) {
                segments.push(dirVal + val); // Combine into 'E15'
                dirVal = "";
              } else {
                segments.push(val);
              }
            }
          }
        }
        event.value = segments.join('-');
      `;

      // Inject the calculation script directly into the text field dictionary
      orderingCodeField.acroField.dict.set(
        PDFName.of('AA'),
        pdfDoc.context.obj({
          C: { S: 'JavaScript', JS: acroCalcScript }
        })
      );
    }

    form.updateFieldAppearances(customFont);
    const pdfBytes = await pdfDoc.save();

    return res.status(200).json({ pdf_base64: Buffer.from(pdfBytes).toString('base64') });

  } catch (error) {
    console.error('Render Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
