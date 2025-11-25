import axios from 'axios';
export async function httpGet(url, config) {
    const res = await axios.get(url, config);
    return res.data;
}
export async function httpPost(url, body, config) {
    const res = await axios.post(url, body, config);
    return res.data;
}
