// feedLibrary.js
// Curated RSS feed library organized by category.
// Used for the feed picker in the client modal.

const FEED_LIBRARY = {
  "US News": [
    { label: "AP News – Top Headlines",    url: "https://feeds.apnews.com/rss/apf-topnews",             category: "us-news" },
    { label: "NPR – News",                 url: "https://feeds.npr.org/1001/rss.xml",                   category: "us-news" },
    { label: "CNN – Top Stories",          url: "http://rss.cnn.com/rss/cnn_topstories.rss",            category: "us-news" },
    { label: "Fox News – Latest",          url: "https://moxie.foxnews.com/google-publisher/latest.xml",category: "us-news" },
    { label: "NBC News",                   url: "http://feeds.nbcnews.com/nbcnews/public/news",          category: "us-news" },
    { label: "ABC News – Top Stories",     url: "https://feeds.abcnews.com/abcnews/topstories",         category: "us-news" },
    { label: "USA Today",                  url: "http://rssfeeds.usatoday.com/usatoday-NewsTopStories", category: "us-news" },
  ],
  "Politics": [
    { label: "Politico",                   url: "https://www.politico.com/rss/politicopicks.xml",       category: "politics" },
    { label: "The Hill",                   url: "https://thehill.com/news/feed/",                       category: "politics" },
    { label: "NPR – Politics",             url: "https://feeds.npr.org/1014/rss.xml",                   category: "politics" },
    { label: "AP – Politics",             url: "https://feeds.apnews.com/rss/apf-politics",             category: "politics" },
    { label: "CNN – Politics",             url: "http://rss.cnn.com/rss/cnn_allpolitics.rss",           category: "politics" },
    { label: "Fox News – Politics",        url: "https://moxie.foxnews.com/google-publisher/politics.xml", category: "politics" },
    { label: "Washington Post – Politics", url: "https://feeds.washingtonpost.com/rss/politics",        category: "politics" },
  ],
  "World News": [
    { label: "BBC News – World",           url: "https://feeds.bbci.co.uk/news/world/rss.xml",          category: "world" },
    { label: "Reuters – World",            url: "https://feeds.reuters.com/reuters/worldnews",          category: "world" },
    { label: "Al Jazeera",                 url: "https://www.aljazeera.com/xml/rss/all.xml",            category: "world" },
    { label: "Guardian – World",           url: "https://www.theguardian.com/world/rss",                category: "world" },
    { label: "NY Times – World",           url: "https://rss.nytimes.com/services/xml/rss/nyt/World.xml", category: "world" },
  ],
  "Technology": [
    { label: "TechCrunch",                 url: "https://techcrunch.com/feed/",                         category: "technology" },
    { label: "The Verge",                  url: "https://www.theverge.com/rss/index.xml",               category: "technology" },
    { label: "Ars Technica",               url: "https://feeds.arstechnica.com/arstechnica/index",      category: "technology" },
    { label: "Wired",                      url: "https://www.wired.com/feed/rss",                       category: "technology" },
    { label: "BBC – Technology",           url: "https://feeds.bbci.co.uk/news/technology/rss.xml",     category: "technology" },
    { label: "Hacker News (top)",          url: "https://hnrss.org/frontpage",                          category: "technology" },
    { label: "MIT Tech Review",            url: "https://www.technologyreview.com/feed/",               category: "technology" },
  ],
  "Business & Finance": [
    { label: "Yahoo Finance",              url: "https://finance.yahoo.com/news/rssindex",              category: "finance" },
    { label: "Reuters – Business",         url: "https://feeds.reuters.com/reuters/businessNews",       category: "finance" },
    { label: "BBC – Business",             url: "https://feeds.bbci.co.uk/news/business/rss.xml",       category: "finance" },
    { label: "CNBC – Top News",            url: "https://www.cnbc.com/id/100003114/device/rss/rss.html",category: "finance" },
    { label: "Bloomberg – Markets",        url: "https://feeds.bloomberg.com/markets/news.rss",         category: "finance" },
    { label: "Forbes",                     url: "https://www.forbes.com/real-time/feed2/",              category: "finance" },
  ],
  "Entertainment": [
    { label: "Entertainment Weekly",       url: "https://ew.com/feed/",                                 category: "entertainment" },
    { label: "Hollywood Reporter",         url: "https://www.hollywoodreporter.com/feed/",              category: "entertainment" },
    { label: "Variety",                    url: "https://variety.com/feed/",                            category: "entertainment" },
    { label: "Rolling Stone",              url: "https://www.rollingstone.com/feed/",                   category: "entertainment" },
    { label: "Deadline",                   url: "https://deadline.com/feed/",                           category: "entertainment" },
  ],
  "Sports": [
    { label: "ESPN",                       url: "https://www.espn.com/espn/rss/news",                   category: "sports" },
    { label: "BBC Sport",                  url: "https://feeds.bbci.co.uk/sport/rss.xml",               category: "sports" },
    { label: "CBS Sports",                 url: "https://www.cbssports.com/rss/headlines/",             category: "sports" },
    { label: "Sky Sports",                 url: "https://www.skysports.com/rss/12040",                  category: "sports" },
  ],
  "Science & Health": [
    { label: "Scientific American",        url: "https://www.scientificamerican.com/feed/",             category: "science" },
    { label: "NASA",                       url: "https://www.nasa.gov/news-release/feed/",              category: "science" },
    { label: "Reuters – Science",          url: "https://feeds.reuters.com/reuters/scienceNews",        category: "science" },
    { label: "BBC – Science",              url: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml", category: "science" },
    { label: "WebMD Health",               url: "https://rssfeeds.webmd.com/rss/rss.aspx?RSSSource=RSS_PUBLIC", category: "health" },
  ],
  "India": [
    { label: "Times of India",             url: "https://timesofindia.indiatimes.com/rssfeedstopstories.cms", category: "india" },
    { label: "The Hindu",                  url: "https://www.thehindu.com/feeder/default.rss",          category: "india" },
    { label: "Economic Times",             url: "https://economictimes.indiatimes.com/rssfeedsdefault.cms", category: "india" },
    { label: "NDTV – Top Stories",         url: "https://feeds.feedburner.com/ndtvnews-top-stories",    category: "india" },
    { label: "India Today",                url: "https://www.indiatoday.in/rss/home",                   category: "india" },
    { label: "Hindustan Times",            url: "https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml", category: "india" },
  ],
  "Crypto & Web3": [
    { label: "CoinDesk",                   url: "https://www.coindesk.com/arc/outboundfeeds/rss/",      category: "crypto" },
    { label: "CoinTelegraph",              url: "https://cointelegraph.com/rss",                        category: "crypto" },
    { label: "Decrypt",                    url: "https://decrypt.co/feed",                              category: "crypto" },
  ],
};

module.exports = { FEED_LIBRARY };