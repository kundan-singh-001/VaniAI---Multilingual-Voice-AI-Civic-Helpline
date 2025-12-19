
export interface ComplaintData {
  id: string;
  callReference: string;
  timestamp: string;
  complaintType: string;
  description: string;
  wardNumber?: string;
  zone?: string;
  language: string;
  status: 'Registered' | 'Assigned' | 'Resolved';
}

export interface TranscriptionItem {
  id: string;
  sender: 'user' | 'ai';
  text: string;
  timestamp: Date;
}
