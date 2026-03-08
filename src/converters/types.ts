// Converter types to transform Postman collections into LangChain tools.

export interface PostmanDescriptionObject {
  content?: string;
}

export type PostmanDescription = string | PostmanDescriptionObject;

export interface PostmanQueryParam {
  key: string;
  description?: string;
}

export interface PostmanUrlObject {
  raw: string;
  path?: string[];
  query?: PostmanQueryParam[];
}

export type PostmanUrl = string | PostmanUrlObject;

export interface PostmanBodyField {
  key: string;
  description?: string;
  type?: string;
}

export interface PostmanBody {
  mode?: "raw" | "urlencoded" | "formdata";
  raw?: string;
  urlencoded?: PostmanBodyField[];
  formdata?: PostmanBodyField[];
}

export interface PostmanRequestDetail {
  method: string;
  url: PostmanUrl;
  body?: PostmanBody;
  description?: PostmanDescription;
}

export interface PostmanItem {
  name: string;
  request?: PostmanRequestDetail;
  item?: PostmanItem[];
}

export interface PostmanCollectionInfo {
  name?: string;
}

export interface PostmanCollection {
  info?: PostmanCollectionInfo;
  item: PostmanItem[];
}

export interface PostmanRequest {
  name: string;
  request: PostmanRequestDetail;
}