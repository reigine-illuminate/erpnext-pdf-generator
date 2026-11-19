// This file contains a serverless function that generates a PDF from HTML using Puppeteer and pdf-lib.

import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { PDFDocument, rgb, StandardFonts, PDFName, PDFString, PDFDict, PDFArray } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    // 1. EXTRACT BRAND FROM PAYLOAD
    const { html, configurator_options, product_slug, brand } = req.body;
    if (!html) return res.status(400).json({ error: 'Missing html in request body' });

    const cleanHtml = html.replace(/\\n/g, '');
    chromium.setGraphicsMode = false;

    // 2. LAUNCH SERVERLESS BROWSER
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    // ilLumenate (owner, 2026-11-19): Manrope and Poppins from the static files in fonts/ instead
    // of Google's. Chromium cannot embed Google's variable Manrope as a normal font, so its text
    // became Type 3 fonts that some viewers draw badly (uneven spacing, broken letters). The
    // page's Google Fonts request (http or https) is answered with Google's own CSS minus these
    // families' faces, plus one face per static weight. Missing files are skipped.
    if (brand === 'illumenate') {
      const LOCAL_FONTS = {
        Manrope: { 200: 'Manrope-ExtraLight.ttf', 300: 'Manrope-Light.ttf', 400: 'Manrope-Regular.ttf',
          500: 'Manrope-Medium.ttf', 600: 'Manrope-SemiBold.ttf', 700: 'Manrope-Bold.ttf', 800: 'Manrope-ExtraBold.ttf' },
        Poppins: { 300: 'Poppins-Light.ttf', 400: 'Poppins-Regular.ttf', 500: 'Poppins-Medium.ttf',
          600: 'Poppins-SemiBold.ttf', 700: 'Poppins-Bold.ttf' },
      };
      const localCss = {};
      Object.entries(LOCAL_FONTS).forEach(([family, files]) => {
        const faces = Object.entries(files).map(([weight, file]) => {
          try {
            const data = fs.readFileSync(path.join(process.cwd(), 'fonts', file)).toString('base64');
            return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:block;`
              + `src:url(data:font/ttf;base64,${data}) format('truetype');}`;
          } catch (e) { return ''; }
        }).join('\n');
        if (faces) localCss[family] = faces;
      });
      const families = Object.keys(localCss);
      if (families.length) {
        await page.setRequestInterception(true);
        page.on('request', async request => {
          const url = request.url();
          const asked = families.filter(family => new RegExp(family, 'i').test(url));
          if (!/^https?:\/\/fonts\.googleapis\.com\/css/.test(url) || !asked.length) return request.continue();
          let css = '';
          try {
            const response = await fetch(url.replace(/^http:/, 'https:'), { headers: { 'user-agent': await browser.userAgent() } });
            css = await response.text();
            asked.forEach(family => {
              css = css.replace(new RegExp(`@font-face\\s*\\{[^}]*font-family:\\s*['"]?${family}['"]?[^}]*\\}`, 'g'), '');
            });
          } catch (e) { css = ''; }
          request.respond({ status: 200, contentType: 'text/css', body: asked.map(family => localCss[family]).join('\n') + '\n' + css });
        });
      }
    }

    await page.setContent(cleanHtml, { waitUntil: 'networkidle0' });

    // 3. DYNAMIC CSS 
    await page.addStyleTag({
      content: `
        @media print {
          @page { size: 8.5in 11in; margin: 0 !important; }
          html, body { 
            margin: 0 !important; 
            padding: 0 !important; 
            background: white !important; 
            -webkit-print-color-adjust: exact !important; 
            print-color-adjust: exact !important;
          }
          .page-wrapper {
            width: 8.5in !important;
            height: 11in !important;
            margin: 0 !important;
            padding: ${brand === 'illumenate' ? '36px' : '0'} !important;
            box-sizing: border-box !important;
            box-shadow: none !important;
            border: none !important;
            page-break-after: always !important;
            break-after: page !important;
            overflow: hidden !important;
            position: relative !important;
          }
          .page-wrapper:last-of-type {
            page-break-after: avoid !important;
            break-after: avoid !important;
          }
        }
      `
    });

    // ilLumenate (owner, 2026-11-19): borders thinner than 1px. Chromium prints every border
    // at least 1px (about 0.72pt) thick, whatever the stylesheet says; a box shadow keeps its
    // real width. So each border the page's stylesheets give a width under 1px is drawn as a
    // shadow of that width and colour instead. Media rules count only when they match.
    if (brand === 'illumenate') {
      await page.evaluate(() => {
        const thin = [];
        const sides = ['top', 'right', 'bottom', 'left'];
        const walk = rules => {
          for (const rule of rules) {
            if (rule.media) {
              if (window.matchMedia(rule.media.mediaText).matches) { try { walk(rule.cssRules); } catch (e) {} }
              continue;
            }
            if (!rule.selectorText || !rule.style) continue;
            sides.forEach(side => {
              // A shorthand with a var() colour leaves the width longhand empty, so the width is
              // also read from the border-<side> and border shorthands.
              const texts = [rule.style.getPropertyValue(`border-${side}-width`),
                rule.style.getPropertyValue(`border-${side}`), rule.style.getPropertyValue('border')];
              for (const text of texts) {
                const match = /(^|\s)(\d*\.?\d+)px(\s|$)/.exec(text || '');
                if (!match) continue;
                const value = parseFloat(match[2]);
                if (value > 0 && value < 1) thin.push([rule.selectorText, side, value]);
                break;
              }
            });
          }
        };
        for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch (e) {} }
        // An outer shadow moved out by the border's width. It is 0.5px smaller all round (and moved
        // 0.5px further) so its ends do not sit on the box's own edges, which left a faint seam.
        const offset = { top: w => `0 -${w + 0.5}px`, bottom: w => `0 ${w + 0.5}px`, left: w => `-${w + 0.5}px 0`, right: w => `${w + 0.5}px 0` };
        thin.forEach(([selector, side, width]) => {
          let elements = [];
          try { elements = document.querySelectorAll(selector); } catch (e) { return; }
          elements.forEach(el => {
            const style = getComputedStyle(el);
            if (style.getPropertyValue(`border-${side}-style`) === 'none') return;
            const color = style.getPropertyValue(`border-${side}-color`);
            el.style.setProperty(`border-${side}-width`, '0px');
            const shadow = `${offset[side](width)} 0 -0.5px ${color}`;
            el.style.boxShadow = el.style.boxShadow && el.style.boxShadow !== 'none' ? `${el.style.boxShadow}, ${shadow}` : shadow;
          });
        });
      });
    }

    await page.setViewport({ width: 816, height: 1056, deviceScaleFactor: 4 });
    await page.emulateMediaType('print');

    // 4. EXTRACT DOM COORDINATES
    const domExtraction = await page.evaluate(() => {
      const wrappers = Array.from(document.querySelectorAll('.page-wrapper'));
      wrappers.forEach((wrapper, index) => {
        const pageNo = wrapper.querySelector('#current-page-no') || wrapper.querySelector('#spec-current-page-no');
        const totalNo = wrapper.querySelector('#total-page-no') || wrapper.querySelector('#spec-total-pages-count');
        if (pageNo) pageNo.innerText = String(index + 1);
        if (totalNo) totalNo.innerText = String(wrappers.length);
      });

      const items = document.querySelectorAll('[data-step]');
      const coords = [];

      items.forEach(item => {
        const chkbx = item.querySelector('#series-btn') || item.querySelector('#part-no-btn') || item.querySelector('.ordering-code-chkbx') || item;

        const rect = chkbx.getBoundingClientRect();
        const pageWrapper = chkbx.closest('.page-wrapper');

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
          codeBox.style.color = 'transparent';
        }
      }

      // --- ILLUMENATE: INDIVIDUAL SECTION INPUTS ---
      let partNoInputCoords = [];
      // A box in a .part-no-section or .part-no-feed-section takes the step of the circles below it
      // and fills in from them. The Length box (.part-no-length, tagged data-input-step by n8n) has
      // no circles: it is a free text box.
      const partNoInputs = document.querySelectorAll('#part-no-code-input, .part-no-code-input, .part-no-feeddir-input');
      partNoInputs.forEach(input => {
        const rect = input.getBoundingClientRect();
        const pageWrapper = input.closest('.page-wrapper');
        if (pageWrapper) {
          const wrapperRect = pageWrapper.getBoundingClientRect();
          const pageIndex = wrappers.indexOf(pageWrapper);
          
          const section = input.closest('.part-no-section, .part-no-feed-section, .part-no-length') || input.closest('[class*="part-no-section"]');
          let step = null;
          let freeText = false;
          if (section) {
            const inputStep = section.getAttribute('data-input-step');
            const firstRadio = section.querySelector('[data-step]');
            if (inputStep) { step = inputStep; freeText = true; }
            else if (firstRadio) step = firstRadio.getAttribute('data-step');
          }

          if (step) {
            let fieldH = rect.height * 0.75;
            let fieldY = 792 - ((rect.top - wrapperRect.top) * 0.75) - fieldH;
            
            if (fieldH < 10) {
              fieldH = 14; 
              fieldY = 792 - ((rect.top - wrapperRect.top) * 0.75);
            }

            partNoInputCoords.push({
              step: step,
              freeText: freeText,
              pageIndex: pageIndex !== -1 ? pageIndex : wrappers.length - 1,
              x: (rect.left - wrapperRect.left) * 0.75,
              y: fieldY + 1,
              width: rect.width * 0.75,
              height: fieldH - 2
            });
            input.style.color = 'transparent';
          }
        }
      });

      const highlightItems = document.querySelectorAll('[data-highlight]');
      const highlightCoords = [];

      highlightItems.forEach(item => {
        const rect = item.getBoundingClientRect();
        const pageWrapper = item.closest('.page-wrapper');
        if (!pageWrapper) return;

        const pageIndex = wrappers.indexOf(pageWrapper);
        const wrapperRect = pageWrapper.getBoundingClientRect();

        let relativeLeft = rect.left - wrapperRect.left;
        let relativeTop = rect.top - wrapperRect.top;
        let elemWidth = rect.width;
        let elemHeight = rect.height;

        const tableContainer = item.closest('#spec-dynamic-table-container');
        if (tableContainer) {
          const contRect = tableContainer.getBoundingClientRect();
          relativeLeft = contRect.left - wrapperRect.left;
          elemWidth = contRect.width;
        }

        const code = item.getAttribute('data-highlight') || '';

        highlightCoords.push({
          code: code.trim(),
          pageIndex: pageIndex !== -1 ? pageIndex : wrappers.length - 1,
          x: relativeLeft * 0.75,
          y: 792 - (relativeTop * 0.75) - (elemHeight * 0.75),
          width: elemWidth * 0.75,
          height: elemHeight * 0.75,
          isRow: !!tableContainer
        });
      });

      // Radio colour set by n8n on the Part Number Builder (ilLumenate fixtures: #ffac33).
      const builder = document.getElementById('part-no-builder');
      const radioHex = builder ? (builder.getAttribute('data-radio-color') || '') : '';

      return { coords, codeBoxCoords, partNoInputCoords, highlightCoords, radioHex };
    });

    // 5. SNAP BASE PDF
    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      preferCSSPageSize: true
    });

    await browser.close();

    // 6. LOAD PDF-LIB TO STAMP INTERACTIVE ACROFORMS
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    pdfDoc.registerFontkit(fontkit);

    if (domExtraction.highlightCoords && domExtraction.highlightCoords.length > 0) {
      pdfDoc.setSubject(JSON.stringify(domExtraction.highlightCoords));
    }

    // 7. FONT OF THE FILLABLE FIELDS (Helvetica Bold for ilLumenate, Times Roman for 206)
    // ilLumenate (owner, 2026-11-19): Helvetica Bold, one of the fonts every PDF viewer has built
    // in. With the embedded Manrope, viewers that redraw a field (Chrome, Preview) decoded its
    // letters wrongly and showed Greek-looking characters.
    const timesRoman = await pdfDoc.embedFont(StandardFonts.TimesRoman);
    const liveFont = brand === 'illumenate' ? await pdfDoc.embedFont(StandardFonts.HelveticaBold) : timesRoman;

    const form = pdfDoc.getForm();
    const pages = pdfDoc.getPages();
    
    form.acroForm.dict.set(PDFName.of('DR'), pdfDoc.context.obj({
      Font: { [liveFont.name]: liveFont.ref }
    }));
    form.acroForm.dict.set(PDFName.of('DA'), PDFString.of(`/${liveFont.name} 0 Tf 0 g`));
    const textColor = rgb(36 / 255, 36 / 255, 2 / 255);

    // --- A. DYNAMIC PROJECT DETAILS TEXT INPUTS ---
    let headerConfigs = [];
    
    if (brand === 'illumenate') {
      // Calculated Footer Coordinates (Locked In!)
      headerConfigs = [
        { name: 'project_name', x: 83, y: 46, width: 188, height: 14 },
        { name: 'fixture_type', x: 333, y: 46, width: 96, height: 14 },
        { name: 'project_location', x: 477, y: 46, width: 109, height: 14 }
      ];
    } else {
      // 206 Lighting Coordinates
      headerConfigs = [
        { name: 'project_name', x: 79, y: 705, width: 130, height: 16 },
        { name: 'fixture_type', x: 267, y: 705, width: 130, height: 16 },
        { name: 'project_location', x: 442, y: 705, width: 140, height: 16 }
      ];
    }

    headerConfigs.forEach(cfg => {
      const tf = form.createTextField(cfg.name);
      // ilLumenate (owner, 2026-11-19): the footer fields are on every page (one field, so a
      // value typed once shows on all of them) and have no background, so the page's underline
      // shows through. 206 Lighting keeps its first two pages and white boxes.
      const isIllumenate = brand === 'illumenate';
      pages.forEach(p => {
        if (isIllumenate || pages.indexOf(p) < 2) {
            tf.addToPage(p, {
              x: cfg.x, y: cfg.y, width: cfg.width, height: cfg.height,
              borderWidth: 0, textColor, font: liveFont,
              // pdf-lib draws a white box unless backgroundColor is given (undefined = none).
              backgroundColor: isIllumenate ? undefined : rgb(1, 1, 1),
              ...(isIllumenate ? { borderColor: undefined } : {}),
            });
        }
      });
      tf.setFontSize(10);
      tf.updateAppearances(liveFont);
    });

    // --- B. INTERACTIVE RADIO BUTTONS & LENGTH INPUT OVERLAYS ---
    const domCoords = domExtraction.coords;
    const autoSelectedValues = {}; // Maps step to selected code for pre-filling!
    
    const safeSlug = (product_slug || "").toUpperCase();
    if (Array.isArray(configurator_options) && safeSlug) {
      const hasSeries = configurator_options.some(c => c.option_step === 0 && c.option_type === "Series");
      if (!hasSeries) {
        configurator_options.unshift({
          option_step: 0,
          option_type: "Series",
          is_required: 1,
          allowed_values: [{ code: safeSlug }]
        });
      }
    }

    if (Array.isArray(configurator_options)) {
      configurator_options.forEach((step) => {
        const stepStr = String(step.option_step);
        const stepName = `step_${stepStr}`;
        const stepCoords = domCoords.filter(c => c.step === stepStr);

        if (stepCoords.length === 0) return;

        if (step.option_type === "Length" && brand !== 'illumenate') {
          const lengthCoord = stepCoords[0];
          const targetPage = pages[lengthCoord.pageIndex] || pages[pages.length - 1];
          const lengthField = form.createTextField(stepName);

          lengthField.addToPage(targetPage, {
            x: lengthCoord.x,
            y: lengthCoord.y - 1,
            width: 65, height: 14,
            borderWidth: 0.5, borderColor: textColor, textColor, font: liveFont,
          });
          lengthField.setFontSize(9);
          lengthField.updateAppearances(liveFont);

        } else {
          const radioGroup = form.createRadioGroup(stepName);
          let defaultSelectedCode = null;

          let allowedValues = Array.isArray(step.allowed_values) ? step.allowed_values : [];

          const isIllumenate = brand === 'illumenate';
          const hex = /^#[0-9a-f]{6}$/i.test(domExtraction.radioHex || '') ? domExtraction.radioHex : null;
          const radioColor = !isIllumenate ? textColor
            : hex ? rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255)
            : rgb(0 / 255, 104 / 255, 51 / 255);
          const radioBorder = 0.5;

          stepCoords.forEach((coord) => {
            const targetPage = pages[coord.pageIndex] || pages[pages.length - 1];
            
            // Set dimensions to exactly 8px by 8px
            const finalWidth = isIllumenate ? 8 : (coord.width || 7);
            const finalHeight = isIllumenate ? 8 : (coord.height || 7);
            
            const radioOffsetX = isIllumenate ? ((coord.width || 10) - 8) / 2 : 0;
            const radioOffsetY = isIllumenate ? ((coord.height || 10) - 8) / 2 : 0;
            
            const finalX = coord.x + radioOffsetX;
            const finalY = coord.y + radioOffsetY;

            radioGroup.addOptionToPage(coord.code, targetPage, {
              x: finalX, 
              y: finalY, 
              width: finalWidth, 
              height: finalHeight,
              borderWidth: radioBorder, 
              borderColor: radioColor, 
              textColor: radioColor, 
            });
          });

          if (step.is_required == 1 || step.is_required === true) {
            if (allowedValues.length === 1) {
              defaultSelectedCode = String(allowedValues[0].code || allowedValues[0].value);
            } else if (!isIllumenate) {
              // ilLumenate (owner, 2026-11-19): no option is picked in advance. A pre-picked
              // default (WH, MC, SV) could not be clicked to fill its code box, since clicking
              // the selected option is no change. Steps with one option stay selected.
              allowedValues.forEach((valObj) => {
                if (valObj.is_default === 1 && !defaultSelectedCode) {
                  defaultSelectedCode = String(valObj.code || valObj.value);
                }
              });
            }
          }

          if (defaultSelectedCode) {
            autoSelectedValues[stepStr] = defaultSelectedCode; // Log for pre-filling!
            try { radioGroup.select(defaultSelectedCode); } catch (e) {}
          }
        }
      });
    }

    // --- C. DYNAMIC ACROJS ORDERING CODE GENERATOR ---
    if (brand === 'illumenate') {
      
      const partNoInputs = domExtraction.partNoInputCoords;
      // The code boxes match the radio colour (fixtures #ffac33, owner 2026-11-18), else green.
      const codeHex = /^#[0-9a-f]{6}$/i.test(domExtraction.radioHex || '') ? domExtraction.radioHex : null;
      const codeColor = codeHex
        ? rgb(parseInt(codeHex.slice(1, 3), 16) / 255, parseInt(codeHex.slice(3, 5), 16) / 255, parseInt(codeHex.slice(5, 7), 16) / 255)
        : rgb(0 / 255, 104 / 255, 51 / 255);
      if (partNoInputs && partNoInputs.length > 0) {
        
        const calcOrder = []; // Fixes the calculation override bug!

        partNoInputs.forEach(coord => {
          const targetPage = pages[coord.pageIndex] || pages[pages.length - 1];
          const displayField = form.createTextField('display_step_' + coord.step);
          
          displayField.addToPage(targetPage, {
            x: coord.x,
            y: coord.y,
            width: coord.width,
            height: coord.height,
            font: liveFont,
            textColor: codeColor,
            borderWidth: 0,
          });
          displayField.setFontSize(10);
          displayField.acroField.dict.set(PDFName.of('Q'), pdfDoc.context.obj(1));
          
          // Pre-fill the box immediately if the radio button below it was auto-selected
          if (autoSelectedValues[coord.step]) {
            displayField.setText(autoSelectedValues[coord.step]);
          }

          // The Length box: anyone can type into it, nothing fills it in.
          const calcScript = coord.freeText ? '' : `
            var f = this.getField("step_${coord.step}");
            if (f) {
              var v = f.value;
              if (v !== null && v !== "Off" && v !== "__none__") {
                event.value = String(v);
              }
            }
          `;
          if (calcScript) {
            const jsStreamRef = pdfDoc.context.register(pdfDoc.context.flateStream(calcScript));
            const calcAction = pdfDoc.context.register(pdfDoc.context.obj({
              S: 'JavaScript',
              JS: jsStreamRef,
            }));
            displayField.acroField.dict.set(PDFName.of('AA'), pdfDoc.context.obj({ C: calcAction }));
          }

          const fieldRef = displayField.acroField.ref;
          const fieldDict = displayField.acroField.dict;
          const widgetRef = fieldDict.lookup(PDFName.of('Kids'), PDFArray).get(0);
          const widgetDict = pdfDoc.context.lookup(widgetRef, PDFDict);
          ['T', 'FT', 'Ff', 'V', 'DA', 'AA', 'Q'].forEach((k) => {
            const val = fieldDict.get(PDFName.of(k));
            if (val) widgetDict.set(PDFName.of(k), val);
          });
          widgetDict.delete(PDFName.of('Parent'));
          
          const fieldsArr = form.acroForm.dict.lookup(PDFName.of('Fields'), PDFArray);
          for (let i = 0; i < fieldsArr.size(); i++) {
            if (String(fieldsArr.get(i)) === String(fieldRef)) fieldsArr.set(i, widgetRef);
          }
          
          calcOrder.push(widgetRef); // Aggregate all fields for the calculation order
        });
        
        // Register ALL text fields into the Master Calculation Order list!
        if (calcOrder.length > 0) {
          form.acroForm.dict.set(PDFName.of('CO'), pdfDoc.context.obj(calcOrder));
        }
        
        form.acroForm.dict.delete(PDFName.of('NeedAppearances'));
      }
      
    } else {
      
      // 206 LIGHTING LOGIC
      const codeBox = domExtraction.codeBoxCoords;
      if (codeBox && Array.isArray(configurator_options)) {
        const targetPage = pages[codeBox.pageIndex] || pages[pages.length - 1];
        const orderingCodeField = form.createTextField('SpecOrderingCode');

        orderingCodeField.addToPage(targetPage, {
          x: codeBox.x,
          y: codeBox.y + 1,
          width: codeBox.width,
          height: codeBox.height - 2.5,
          font: liveFont,
          textColor: textColor,
          borderWidth: 0,
        });
        orderingCodeField.setFontSize(10);

        const acroSteps = configurator_options.map(s => ({
          stepName: 'step_' + s.option_step,
          type: s.option_type,
          label: s.option_label || ''
        })).sort((a, b) => parseInt(a.stepName.split('_')[1]) - parseInt(b.stepName.split('_')[1]));

        let initialSegments = [];
        let initialDir = "";
        
        for (let i = 0; i < acroSteps.length; i++) {
          let field;
          try { field = form.getField(acroSteps[i].stepName); } catch (e) { field = null; }
          if (field) {
            let val = (typeof field.getSelected === 'function') ? field.getSelected() : field.getText();
            if (val && val !== "Off" && val !== "") {
              let isDir = acroSteps[i].type === "Feed Direction" && acroSteps[i].label.includes("Direction");
              let isLen = acroSteps[i].type === "Feed Direction" && acroSteps[i].label.includes("Length");

              if (isDir) {
                if (initialDir) initialSegments.push(initialDir);
                initialDir = val;
              } else if (isLen) {
                initialSegments.push(initialDir + val);
                initialDir = "";
              } else {
                if (initialDir) { initialSegments.push(initialDir); initialDir = ""; }
                initialSegments.push(val);
              }
            }
          }
        }
        if (initialDir) initialSegments.push(initialDir);
        orderingCodeField.setText(initialSegments.join('-'));
        orderingCodeField.updateAppearances(liveFont);

        const stepNames = acroSteps.map(s => s.stepName);
        const isDirFlags = acroSteps.map(s => (s.type === "Feed Direction" && s.label.includes("Direction")));
        const isLenFlags = acroSteps.map(s => (s.type === "Feed Direction" && s.label.includes("Length")));

        const acroCalcScript = `var fields = ${JSON.stringify(stepNames)};
  var isDir = ${JSON.stringify(isDirFlags)};
  var isLen = ${JSON.stringify(isLenFlags)};
  var parts = [];
  var dirVal = "";
  for (var i = 0; i < fields.length; i++) {
    var f = this.getField(fields[i]);
    if (!f) continue;
    var v = f.value;
    if (v === null || v === undefined) continue;
    v = String(v);
    
    if (v === "0") v = ""; 
    
    if (v === "Off" || v === "" || v === "__none__") continue;
    if (isDir[i]) {
      if (dirVal) parts.push(dirVal);
      dirVal = v;
    } else if (isLen[i]) {
      parts.push(dirVal + v);
      dirVal = "";
    } else {
      if (dirVal) { parts.push(dirVal); dirVal = ""; }
      parts.push(v);
    }
  }
  if (dirVal) parts.push(dirVal);
  event.value = parts.join("-");`;

        const jsStreamRef = pdfDoc.context.register(pdfDoc.context.flateStream(acroCalcScript));
        const calcAction = pdfDoc.context.register(pdfDoc.context.obj({
          S: 'JavaScript',
          JS: jsStreamRef,
        }));

        orderingCodeField.acroField.dict.set(PDFName.of('AA'), pdfDoc.context.obj({ C: calcAction }));

        const fieldRef = orderingCodeField.acroField.ref;
        const fieldDict = orderingCodeField.acroField.dict;
        const widgetRef = fieldDict.lookup(PDFName.of('Kids'), PDFArray).get(0);
        const widgetDict = pdfDoc.context.lookup(widgetRef, PDFDict);
        ['T', 'FT', 'Ff', 'V', 'DA', 'AA'].forEach((k) => {
          const val = fieldDict.get(PDFName.of(k));
          if (val) widgetDict.set(PDFName.of(k), val);
        });
        widgetDict.delete(PDFName.of('Parent'));

        const fieldsArr = form.acroForm.dict.lookup(PDFName.of('Fields'), PDFArray);
        for (let i = 0; i < fieldsArr.size(); i++) {
          if (String(fieldsArr.get(i)) === String(fieldRef)) fieldsArr.set(i, widgetRef);
        }
        form.acroForm.dict.set(PDFName.of('CO'), pdfDoc.context.obj([widgetRef]));
        form.acroForm.dict.delete(PDFName.of('NeedAppearances'));
      }
    }

    // ilLumenate (owner, 2026-11-19): no blue field highlight. Acrobat and browser viewers tint
    // fillable fields blue, which made filled-in codes hard to read; this asks the viewer to turn
    // that off when the spec sheet opens. Viewers without PDF scripts ignore it.
    if (brand === 'illumenate') {
      pdfDoc.addJavaScript('ill_no_field_highlight', 'try { app.runtimeHighlight = false; } catch (e) {}');
    }

    const pdfBytes = await pdfDoc.save();

    return res.status(200).json({ pdf_base64: Buffer.from(pdfBytes).toString('base64') });

  } catch (error) {
    console.error('Render Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
