const firstPart = ["Sky", "Star", "Moon", "Fire", "Dark", "Ice", "Neo", "Shadow"];
const secondPart = ["Walker", "Hunter", "Blade", "Runner", "Storm", "Fang", "Strike", "Flame"];



export function generateName(){
    const first = firstPart[Math.floor(Math.random() * firstPart.length)];
    const second = secondPart[Math.floor(Math.random() * secondPart.length)];
    return `${first} ${second}`;
}


export function getAgentInfo(userAgent: string){
    const browser = getBrowser(userAgent);
    const os = getDeviceType(userAgent);
    if(browser && os){
        return `${os} | ${browser}`;
    }else if(os){
        return os;
    }else{
        return browser;
    }
}

export function getBrowser(userAgent: string){
    switch(true){
        case userAgent.includes("Firefox"):
            return "Firefox";
        case userAgent.includes("Edg"):
            return "Edge";
        case userAgent.includes("Opera") || userAgent.includes("OPR"):
            return "Opera";
        case userAgent.includes("Chrome"):
            return "Chrome";
        case userAgent.includes("Safari"):
            return "Safari";
        default:
            return "Unknown browser";
    }
}

export function getDeviceType(userAgent: string){
    switch(true){
        case userAgent.includes("iPhone") || userAgent.includes("iPad"):
            return "iOS";
        case userAgent.includes("Windows"):
            return "Windows";
        case userAgent.includes("Android"):
            return "Android";
        case userAgent.includes("Macintosh"):
            return "macOS";
        case userAgent.includes("Linux") || userAgent.includes("X11"):
            return "Linux";
        default:
            return "Unknown device";
    }
}

