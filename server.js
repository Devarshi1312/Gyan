const express = require('express');
const puppeteer = require('puppeteer');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const pdfParse = require('pdf-parse');

const app = express();
const cors = require('cors');
app.use(cors());
app.use(express.json({ "limit": "1mb" }));
const port = 3001;

const KEYFILE_PATH = '/home/devarshi/Desktop/web/web_backend/gyanbse-7740ece035c9.json';

const auth = new google
    .auth
    .GoogleAuth({ keyFile: KEYFILE_PATH, scopes: ['https://www.googleapis.com/auth/drive.file'] });

const drive = google.drive({ version: 'v3', auth });

async function fetchIndustries() {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    try {
        const url = 'https://www.bseindia.com/markets/Equity/EQReports/industrywatchList.html';
        await page.goto(url, { waitUntil: 'networkidle2' });
        await page.waitForSelector('select[name="selecttype"]');
        const industries = await page.evaluate(() => {
            const options = Array.from(document.querySelectorAll('select[name="selecttype"] option'));
            return options.map(option => ({
                name: option
                    .textContent
                    .trim(),
                value: option.value
            }));
        });
        return industries;
    } catch (error) {
        console.error('Error fetching industries:', error.message);
        return [];
    } finally {
        await browser.close();
    }
}

async function scrapeTableUrls(url1, industry) {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    try {
        const url = `https://www.bseindia.com/markets/Equity/EQReports/IndustryView.html?expandable=2&page=${url1}&scripname=${industry}`;
        await page.goto(url, { waitUntil: 'networkidle2' });
        await page.waitForSelector('table');
        const tableData = await page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('table tbody tr'));
            return rows.map(row => {
                const secondChild = row.children[1];
                if (secondChild) {
                    const CompanyName = secondChild
                        .textContent
                        .trim();
                    const linkElement = secondChild.querySelector('a');
                    const CompanyUrl = linkElement
                        ? linkElement.href
                        : null;
                    return CompanyUrl ? { CompanyName, CompanyUrl } : null;
                }
                return null;
            }).filter(row => row !== null);
        });
        return tableData;
    } catch (error) {
        console.error('Error during scraping:', error.message);
    } finally {
        await browser.close();
    }
}

async function extractHrefsFromDivmain(url1) {
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    try {
        const url = `${url1}financials-annual-reports/`;
        await page.goto(url, { waitUntil: 'networkidle2' });
        await page.waitForSelector('#divmain');
        const hrefs = await page.evaluate(() => {
            const divMain = document.querySelector('#divmain');
            if (!divMain)
                return [];
            const anchorTags = divMain.querySelectorAll('a');
            return Array
                .from(anchorTags)
                .map(anchor => anchor.href);
        });
        return hrefs
    } catch (error) {
        console.error('Error during extraction:', error.message);
    } finally {
        await browser.close();
    }
}

const GYAN_FOLDER_NAME = 'gyan';

async function getGyanFolderId() {
    const query = `name='${GYAN_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder'`;
    const response = await drive.files.list({ q: query, fields: 'files(id, name)', spaces: 'drive' });

    if (response.data.files.length) {
        return response.data.files[0].id;
    } else {
        return await createFolder(GYAN_FOLDER_NAME);
    }
}

async function createFolder(name, parentFolderId = null) {
    const folderMetadata = {
        name: name,
        mimeType: 'application/vnd.google-apps.folder',
        ...(parentFolderId && {
            parents: [parentFolderId]
        })
    };

    const folder = await drive
        .files
        .create({ resource: folderMetadata, fields: 'id' });

    return folder.data.id;
}

async function getFolderId(folderName, parentFolderId = null) {
    const query = `name='${folderName}' and mimeType='application/vnd.google-apps.folder'${parentFolderId
        ? ` and '${parentFolderId}' in parents`
        : ''}`;
    const response = await drive
        .files
        .list({ q: query, fields: 'files(id, name)', spaces: 'drive' });

    if (response.data.files.length) {
        return response.data.files[0].id;
    } else {
        return await createFolder(folderName, parentFolderId);
    }
}

async function uploadFileToGoogleDrive(filePath, fileName, parentFolderId) {
    const fileMetadata = {
        name: fileName,
        parents: [parentFolderId]
    };
    const media = {
        mimeType: 'application/pdf',
        body: fs.createReadStream(filePath)
    };

    const file = await drive
        .files
        .create({ resource: fileMetadata, media: media, fields: 'id' });

    return file.data.id;
}

async function uploadFileFromUrl(fileUrl, industry, companyName) {
    try {
        console.log(`Downloading file from ${fileUrl}...`);
        const response = await axios({ url: fileUrl, method: 'GET', responseType: 'stream' });
        const tempFilePath = path.join(__dirname, `${companyName}.pdf`);
        const writer = fs.createWriteStream(tempFilePath);
        response.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        console.log('Uploading file to Google Drive...');
        const gyanFolderId = await getGyanFolderId();
        const industryFolderId = await getFolderId(industry, gyanFolderId);
        const companyFolderId = await getFolderId(companyName, industryFolderId);
        const fileId = await uploadFileToGoogleDrive(tempFilePath, `${companyName}.pdf`, companyFolderId);

        console.log(`File uploaded successfully! File ID: ${fileId}`);
        fs.unlinkSync(tempFilePath);
        console.log('Temporary file deleted.');
    } catch (error) {
        console.error('Error uploading file:', error.message);
    }
}


async function shareFile(fileId, emailAddress) {
    try {
        const res = await drive
            .permissions
            .create({
                fileId: fileId,
                requestBody: {
                    role: 'writer',
                    type: 'user',
                    emailAddress: emailAddress
                }
            });
        console.log(`File shared with ${emailAddress}`);
        return res;
    } catch (error) {
        console.error('Error sharing file:', error.message);
        return null;
    }
}

async function extractEmailsFromOnlinePdf(pdfUrl) {
    const emails = new Set();
    const phones = new Set();

    try {
        const response = await axios.get(pdfUrl, { responseType: 'arraybuffer' });
        const pdfData = await pdfParse(response.data);
        const text = pdfData.text;

        const emailMatches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
        if (emailMatches) {
            emailMatches.forEach(email => emails.add(email));
        }

        const phoneMatches = text.match(/\b\d{10}\b/g);
        if (phoneMatches) {
            phoneMatches.forEach(phone => phones.add(phone));
        }
        return {
            emails: Array.from(emails),
            phones: Array.from(phones)
        };
    } catch (err) {
        console.error(`Error processing PDF: ${err.message}`);
        return { emails: [], phones: [] };
    }
}

const axiosInstance = axios.create({
    baseURL: 'https://o0uns6ozf4.execute-api.us-east-1.amazonaws.com/web/',
    timeout: 120000, // 20 minutes timeout
    headers: {
        'Content-Type': 'application/json',
    },
});

app.post('/companypdfurl', async (req, res) => {
    const { companyname, companyId } = req.body;
    console.log("Company Name:", companyname);
    console.log("Company ID:", companyId);

    try {
        // Extract PDF URLs
        const pdfUrls = await extractHrefsFromDivmain(companyId);
        if (!pdfUrls || pdfUrls.length < 2) {
            throw new Error("Invalid PDF URL extracted");
        }

        // Extract emails and phones
        const { emails, phones } = await extractEmailsFromOnlinePdf(pdfUrls[1]);

        console.log("======================================");

        // Use Axios instance to send POST request
        const response = await axiosInstance.post('', {
            "Company_Name": companyname,
            "Link": pdfUrls[1],
            "emails": emails,
        });
        console.log("-------------------------------------")
        console.log("Response Data:", response.data);
        res.json(response.data);
    } catch (error) {
        console.error("Error occurred:29", error.message || error);
        res.status(500).json({ error: error.message || "An unknown error occurred" });
    }
});

app.post('/emails', async (req, res) => {
    const { companyId } = req.body;
    console.log("url", companyId);
    const pdfUrl = await extractHrefsFromDivmain(companyId);
    const { emails, phones } = await extractEmailsFromOnlinePdf(pdfUrl[1]);
    res.json({ emails, phones });
});

app.get('/industries', async (req, res) => {
    try {
        const industries = await fetchIndustries();
        console.log(industries);
        res.json(industries);
    } catch (error) {
        res
            .status(500)
            .json({ error: 'Failed to fetch industries' });
    }
});
app.post('/companies', async (req, res) => {
    try {
        const { industries } = req.body;
        const companies = await scrapeTableUrls(industries.value, industries.name);
        return res.json(companies);
    } catch (error) {
        console.error('Error scraping companies:', error.message);
        return res
            .status(500)
            .json({ error: 'Failed to scrape companies' });
    }
})

app.post('/company', async (req, res) => {
    try {
        const industryData = req.body;
        console.log(industryData)

        console.log("Industry Data:", JSON.stringify(industryData));

        for (const industry of industryData) {
            const industryFolderId = await getGyanFolderId();
            for (const company of industry.companies) {
                if (company.CompanyUrl) {
                    const pdfUrls = await extractHrefsFromDivmain(company.CompanyUrl);
                    console.log(pdfUrls.length)
                    if (pdfUrls.length > 1) {
                        await uploadFileFromUrl(pdfUrls[1], industry.industryName, company.CompanyName);
                    }
                }
            }

            const emailAddress = 'test@cumulations.com';
            const s = await shareFile(industryFolderId, emailAddress);
            if (s) {
                // console.log(`File ${JSON.stringify(s)}`);
                return res
                    .status(200)
                    .json({ "message": "files uploaded successfully" })
            } else {
                return res
                    .status(500)
                    .json({ "error": "some error occurred" });
            }

        }
    } catch (error) {
        console.log("some error occured", error);
    }
})
app.post('/industries_data', async (req, res) => {
    try {
        const { industries } = req.body;

        console.log(`Received Industry Name: ${industries.name}`);
        console.log(`Received Industry Value: ${industries.value}`);

        // res.json({   industries });
        const industryData = [];

        const companies = await scrapeTableUrls(industries.value, industries.name);
        industryData.push({ industryName: industries.name, companies });

        console.log("Industry Data:", JSON.stringify(industryData));

        for (const industry of industryData) {
            console.log("hlo")
            const industryFolderId = await getFolderId(industry.industryName);
            for (const company of industry.companies) {
                if (company.CompanyUrl) {
                    const pdfUrls = await extractHrefsFromDivmain(company.CompanyUrl);
                    console.log(pdfUrls)
                    if (pdfUrls.length > 1) {
                        await uploadFileFromUrl(pdfUrls[1], industry.industryName, company.CompanyName);
                        try {
                            const { emails, phones } = await extractEmailsFromOnlinePdf(pdfUrls[1]);
                            // const controller = new AbortController();
                            // const timeoutId = setTimeout(() => controller.abort(), 1200000);
                            console.log("======================================")
                            const response = await axios.post('https://o0uns6ozf4.execute-api.us-east-1.amazonaws.com/web/',
                                {
                                    "Company_Name": company.CompanyName,
                                    "Link": pdfUrls[1],
                                    "emails": emails
                                },
                                {
                                    headers: {
                                        'Content-Type': 'application/json',
                                    }
                                }
                            );
                            const data = await response.data;
                            console.log("----------------------------------");
                            console.log(data.message);
                            console.log("+++++++++++++++++++++++++++++++++");
                        } catch (error) {
                            console.log("rey",error);
                        }
                        // finally{
                        //     clearTimeout(timeoutId);
                        // }
                    }
                }
            }

            const emailAddress = 'test@cumulations.com';
            const s = await shareFile(industryFolderId, emailAddress);
            if (s) {
                // console.log(`File ${JSON.stringify(s)}`);
                return res
                    .status(200)
                    .json({ "message": "files uploaded successfully" })
            } else {
                return res
                    .status(500)
                    .json({ "error": "some error occurred" });
            }

        }
    } catch (error) {
        console.log("some error occured", error);
    }
})
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
